import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { Readable } from 'stream';
import { StreamableFile } from '@nestjs/common';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export type ArquivoRecebido = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

export type ArquivoSalvo = {
  nomeArquivo: string;
  /** Caminho local absoluto OU chave `s3://bucket/key`. */
  caminhoArquivo: string;
  tipoMime: string;
  tamanhoBytes: number;
  hashArquivo: string;
};

const S3_PREFIX = 's3://';

/**
 * Falha de ARMAZENAMENTO (credencial, permissão, bucket, rede) — distinta de
 * arquivo inválido, que é 400 e culpa de quem enviou. Quem chama converte em
 * resposta HTTP; o `causa` preserva o erro do SDK para o log.
 */
export class ErroStorage extends Error {
  constructor(
    message: string,
    readonly causa?: unknown,
  ) {
    super(message);
    this.name = 'ErroStorage';
  }
}

/** Raiz de armazenamento local (só `STORAGE_DRIVER=local`). */
export function uploadsRoot(): string {
  return resolve(process.env.UPLOADS_DIR ?? './uploads');
}

function sanitizarNome(nome: string): string {
  return nome
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
}

function driver(): 'local' | 's3' {
  const d = (process.env.STORAGE_DRIVER ?? 'local').toLowerCase();
  return d === 's3' ? 's3' : 'local';
}

/**
 * Credenciais aceitas nos DOIS nomes, de propósito: o `.env.example` documenta
 * `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` e o `render.yaml` pede
 * `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. Quem seguiu o blueprint e caiu
 * no par `AWS_*` dependia, sem saber, da cadeia padrão do SDK — e qualquer
 * divergência de nome virava um 500 opaco no primeiro upload de documento, já
 * em produção, porque o boot não confere credencial nenhuma.
 */
export function credenciaisS3():
  | { accessKeyId: string; secretAccessKey: string }
  | undefined {
  const id = process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secret =
    process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  return id && secret ? { accessKeyId: id, secretAccessKey: secret } : undefined;
}

function s3Client(): S3Client {
  const region = process.env.S3_REGION ?? process.env.AWS_REGION;
  if (!region) {
    throw new Error('S3_REGION (ou AWS_REGION) é obrigatória com STORAGE_DRIVER=s3');
  }
  const endpoint = process.env.S3_ENDPOINT || undefined;

  /**
   * ⚠️ Checksum desligado quando há `S3_ENDPOINT` (Cloudflare R2, MinIO,
   * Backblaze — qualquer coisa que não seja a S3 da AWS).
   *
   * Desde ~3.729 o SDK v3 assume `requestChecksumCalculation: 'WHEN_SUPPORTED'`
   * e passa a mandar `x-amz-checksum-crc32` em TODO `PutObject`. Serviços
   * compatíveis com S3 costumam recusar esse header ("not implemented"), e a
   * falha aparece só na primeira gravação — nunca no boot. `WHEN_REQUIRED`
   * volta ao comportamento anterior: só calcula checksum quando a operação
   * exige.
   *
   * Na S3 de verdade (sem endpoint custom) o padrão é mantido: lá o checksum
   * funciona e protege contra corrupção em trânsito.
   */
  const compativel = Boolean(endpoint);

  return new S3Client({
    region,
    endpoint,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1',
    // `undefined` deixa o SDK usar a cadeia padrão (perfil, role da instância).
    credentials: credenciaisS3(),
    ...(compativel
      ? {
          requestChecksumCalculation: 'WHEN_REQUIRED' as const,
          responseChecksumValidation: 'WHEN_REQUIRED' as const,
        }
      : {}),
  });
}

function s3Bucket(): string {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET é obrigatória com STORAGE_DRIVER=s3');
  return bucket;
}

function parseS3Uri(caminho: string): { bucket: string; key: string } {
  if (!caminho.startsWith(S3_PREFIX)) {
    throw new Error(`Caminho S3 inválido: ${caminho}`);
  }
  const rest = caminho.slice(S3_PREFIX.length);
  const barra = rest.indexOf('/');
  if (barra <= 0) throw new Error(`Caminho S3 sem chave: ${caminho}`);
  return { bucket: rest.slice(0, barra), key: rest.slice(barra + 1) };
}

/**
 * Grava um arquivo (disco local ou S3) e devolve metadados para o banco.
 * Em produção o boot exige STORAGE_DRIVER=s3 — disco efêmero perde KYC.
 */
export async function salvarArquivo(
  escopo: 'usuarios',
  id: string | bigint,
  arquivo: ArquivoRecebido,
): Promise<ArquivoSalvo> {
  const nomeSanitizado = sanitizarNome(arquivo.originalname || 'arquivo');
  const nomeArmazenado = `${randomUUID()}-${nomeSanitizado}`;
  const hashArquivo = createHash('sha256').update(arquivo.buffer).digest('hex');
  const meta = {
    nomeArquivo: arquivo.originalname || nomeSanitizado,
    tipoMime: arquivo.mimetype,
    tamanhoBytes: arquivo.size ?? arquivo.buffer.length,
    hashArquivo,
  };

  if (driver() === 's3') {
    const bucket = s3Bucket();
    const key = `${escopo}/${id.toString()}/${nomeArmazenado}`;
    try {
      await s3Client().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: arquivo.buffer,
          ContentType: arquivo.mimetype,
          Metadata: { sha256: hashArquivo },
        }),
      );
    } catch (e) {
      /**
       * Sem isto o erro do SDK sobe cru e o Nest devolve
       * `{"statusCode":500,"message":"Internal server error"}` — o admin fica
       * sem saber se o problema é o arquivo, a permissão ou o bucket, e o
       * motivo real só existe no log da plataforma. Falha de storage é do
       * SERVIDOR (500 é o código certo), mas a mensagem tem que dizer o quê.
       */
      throw new ErroStorage(
        `Falha ao gravar o documento no bucket "${bucket}" (chave ${key}): ${
          e instanceof Error ? e.message : String(e)
        }`,
        e,
      );
    }
    return { ...meta, caminhoArquivo: `${S3_PREFIX}${bucket}/${key}` };
  }

  const dir = join(uploadsRoot(), escopo, id.toString());
  await mkdir(dir, { recursive: true });
  const caminhoAbsoluto = join(dir, nomeArmazenado);
  await writeFile(caminhoAbsoluto, arquivo.buffer);
  return { ...meta, caminhoArquivo: caminhoAbsoluto };
}

/** Abre um arquivo salvo para download (admin). */
export async function abrirArquivo(caminhoArquivo: string): Promise<StreamableFile> {
  if (caminhoArquivo.startsWith(S3_PREFIX)) {
    const { bucket, key } = parseS3Uri(caminhoArquivo);
    const out = await s3Client().send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!out.Body) throw new Error(`Objeto S3 vazio: ${caminhoArquivo}`);
    const body = out.Body as { transformToByteArray?: () => Promise<Uint8Array> };
    if (typeof body.transformToByteArray === 'function') {
      const bytes = await body.transformToByteArray();
      return new StreamableFile(Buffer.from(bytes));
    }
    // Fallback stream Node
    return new StreamableFile(out.Body as Readable);
  }
  return new StreamableFile(createReadStream(caminhoArquivo));
}
