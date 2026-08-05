import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { StreamableFile } from '@nestjs/common';

export type ArquivoRecebido = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

export type ArquivoSalvo = {
  nomeArquivo: string;
  caminhoArquivo: string;
  tipoMime: string;
  tamanhoBytes: number;
  hashArquivo: string;
};

/** Raiz de armazenamento local. Trocar por bucket S3 depois sem mudar o contrato. */
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

/**
 * Grava um arquivo em disco sob {UPLOADS_DIR}/{escopo}/{id}/ e devolve os metadados
 * (caminho, hash sha256, tamanho, mime) para persistir no banco.
 */
export async function salvarArquivo(
  escopo: 'usuarios',
  id: string | bigint,
  arquivo: ArquivoRecebido,
): Promise<ArquivoSalvo> {
  const dir = join(uploadsRoot(), escopo, id.toString());
  await mkdir(dir, { recursive: true });

  const nomeSanitizado = sanitizarNome(arquivo.originalname || 'arquivo');
  const nomeArmazenado = `${randomUUID()}-${nomeSanitizado}`;
  const caminhoAbsoluto = join(dir, nomeArmazenado);

  await writeFile(caminhoAbsoluto, arquivo.buffer);
  const hashArquivo = createHash('sha256').update(arquivo.buffer).digest('hex');

  return {
    nomeArquivo: arquivo.originalname || nomeSanitizado,
    caminhoArquivo: caminhoAbsoluto,
    tipoMime: arquivo.mimetype,
    tamanhoBytes: arquivo.size ?? arquivo.buffer.length,
    hashArquivo,
  };
}

/** Abre um arquivo salvo para download (admin). */
export function abrirArquivo(caminhoArquivo: string): StreamableFile {
  return new StreamableFile(createReadStream(caminhoArquivo));
}
