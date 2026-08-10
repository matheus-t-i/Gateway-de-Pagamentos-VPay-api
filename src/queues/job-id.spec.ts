import { QueuesService } from './queues.service';

/**
 * jobId customizado NÃO pode conter ':' — o BullMQ 5 valida no `add` e LANÇA
 * ("Custom Id cannot contain :", `job.js`). Com `saque:<id>`, o enqueue do
 * saque falhava DEPOIS do débito (saldo debitado, nenhum job, 500 para o
 * lojista) e o webhook de cash-in nem entrava na fila — encontrado no smoke
 * da imagem Docker com bullmq 5.81. Este spec reproduz a validação do BullMQ
 * num stub: se alguém voltar a usar ':' num jobId estável, o teste quebra.
 */
describe('QueuesService — jobId estável compatível com BullMQ 5', () => {
  function filaStub() {
    const adds: Array<{ name: string; opts?: { jobId?: string } }> = [];
    return {
      adds,
      add: async (name: string, _data: unknown, opts?: { jobId?: string }) => {
        if (opts?.jobId?.includes(':')) {
          throw new Error('Custom Id cannot contain :');
        }
        if (opts?.jobId && /^\d+$/.test(opts.jobId)) {
          throw new Error('Custom Id cannot be integers');
        }
        adds.push({ name, opts });
        return { id: opts?.jobId };
      },
      getJob: async () => null,
    };
  }

  it('nenhum enqueue de dinheiro usa ":" (ou id numérico puro) no jobId', async () => {
    const filas = Array.from({ length: 12 }, filaStub);
    const svc = new QueuesService(
      ...(filas as [never, never, never, never, never, never, never, never, never, never, never, never]),
    );

    await svc.enqueuePixCashOut({
      provider: 'teste',
      payload: { transacaoId: '123', idTransacaoPrivado: 'p' },
      identificadorRastreio: 'r',
    } as never);
    await svc.enqueuePixWebhookReceived({
      provider: 'teste',
      payload: {},
      webhookRecebidoId: '55',
      identificadorRastreio: 'r',
    } as never);
    await svc.enqueuePixWebhookCashout({
      provider: 'teste',
      payload: {},
      webhookRecebidoId: '56',
      identificadorRastreio: 'r',
    } as never);

    const todos = filas.flatMap((f) => f.adds);
    // Os três enqueues chegaram à fila (nenhum morreu na validação do stub)…
    expect(todos).toHaveLength(3);
    // …e todos com jobId estável definido, sem ':' e não-numérico.
    for (const a of todos) {
      expect(a.opts?.jobId).toBeTruthy();
      expect(a.opts?.jobId).not.toContain(':');
      expect(a.opts?.jobId).not.toMatch(/^\d+$/);
    }
  });
});
