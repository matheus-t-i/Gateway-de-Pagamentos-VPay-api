import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { salvarArquivo } from './storage.util';

/**
 * Storage compatível com S3 (Cloudflare R2, MinIO, Backblaze) contra o SDK v3
 * moderno.
 *
 * Desde ~3.729 o `@aws-sdk/client-s3` assume `requestChecksumCalculation:
 * 'WHEN_SUPPORTED'` e manda `x-amz-checksum-crc32` em TODO `PutObject`. O R2
 * recusa esse header, e o efeito é cruel: o boot passa (bucket e região estão
 * lá), a app sobe, e a falha só aparece no PRIMEIRO upload de documento — em
 * produção, como 500 opaco.
 *
 * Este spec sobe um servidor HTTP local no lugar do R2 e olha os headers que
 * saem de verdade. É a única forma de travar isso sem um bucket real: a opção
 * é interna ao cliente e não aparece em nenhum retorno.
 */
describe('storage S3-compatível (R2) — PutObject sem checksum', () => {
  let servidor: Server;
  let porta: number;
  let headersRecebidos: Record<string, string | string[] | undefined> = {};
  let envOriginal: NodeJS.ProcessEnv;

  beforeAll(async () => {
    envOriginal = { ...process.env };
    servidor = createServer((req, res) => {
      headersRecebidos = req.headers;
      // Consome o corpo antes de responder; o SDK espera 200 + ETag.
      req.on('data', () => undefined);
      req.on('end', () => {
        res.writeHead(200, { ETag: '"abc123"' });
        res.end();
      });
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    porta = (servidor.address() as AddressInfo).port;
  });

  afterAll(async () => {
    process.env = envOriginal;
    await new Promise<void>((ok) => servidor.close(() => ok()));
  });

  beforeEach(() => {
    headersRecebidos = {};
    process.env.STORAGE_DRIVER = 's3';
    process.env.S3_BUCKET = 'vpay-kyc';
    process.env.S3_REGION = 'auto';
    process.env.S3_FORCE_PATH_STYLE = '1';
    process.env.S3_ACCESS_KEY_ID = 'chave-de-teste';
    process.env.S3_SECRET_ACCESS_KEY = 'segredo-de-teste';
    process.env.S3_ENDPOINT = `http://127.0.0.1:${porta}`;
  });

  const arquivo = () => ({
    originalname: 'rg-frente.pdf',
    mimetype: 'application/pdf',
    size: 11,
    buffer: Buffer.from('conteudo-pdf'.slice(0, 11)),
  });

  it('não manda x-amz-checksum-* quando há endpoint custom (R2)', async () => {
    const salvo = await salvarArquivo('usuarios', 42n, arquivo());

    const checksums = Object.keys(headersRecebidos).filter((h) =>
      h.toLowerCase().startsWith('x-amz-checksum-'),
    );
    expect(checksums).toEqual([]);

    // E o objeto foi de fato gravado, com a chave no formato esperado.
    expect(salvo.caminhoArquivo).toMatch(/^s3:\/\/vpay-kyc\/usuarios\/42\//);
    expect(salvo.tipoMime).toBe('application/pdf');
  });

  it('o hash sha256 vai nos metadados, e é do conteúdo', async () => {
    const salvo = await salvarArquivo('usuarios', 7n, arquivo());
    expect(headersRecebidos['x-amz-meta-sha256']).toBe(salvo.hashArquivo);
    expect(salvo.hashArquivo).toHaveLength(64);
  });

  it('falha do storage vira ErroStorage com a causa, não erro cru do SDK', async () => {
    // Endpoint morto: nada escuta nesta porta.
    process.env.S3_ENDPOINT = 'http://127.0.0.1:1';
    await expect(salvarArquivo('usuarios', 1n, arquivo())).rejects.toMatchObject({
      name: 'ErroStorage',
      // A mensagem tem que dizer ONDE falhou — era o que faltava no 500 opaco.
      message: expect.stringContaining('vpay-kyc'),
    });
  });
});
