import { Decimal, money } from '../shared';

/**
 * Extrai valor monetário de payload/raw da liquidante (campos comuns).
 * Retorna null se nada utilizável — Camada 1 deve falhar fechada.
 */
export function extrairValorDePayload(raw: unknown): Decimal | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' || typeof raw === 'string') {
    try {
      const v = money(String(raw));
      return v.isFinite() && v.gte(0) ? v.toDecimalPlaces(2) : null;
    } catch {
      return null;
    }
  }
  if (typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const candidatos = [
    o.amount,
    o.valor,
    o.value,
    o.transaction_amount,
    o.valorPago,
    o.valor_pago,
    o.valorBruto,
    o.valor_bruto,
  ];
  for (const c of candidatos) {
    if (c === undefined || c === null || c === '') continue;
    try {
      const v = money(String(c));
      if (v.isFinite() && v.gte(0)) return v.toDecimalPlaces(2);
    } catch {
      /* próximo campo */
    }
  }
  return null;
}

const TOLERANCIA = money('0.01');

/**
 * Recusa crédito se o valor remoto não bater com o bruto local.
 * Sem valor remoto → fail-closed (não credita às cegas).
 */
export function assertValorCamada1Compativel(
  valorBrutoLocal: Decimal,
  valorRemoto: Decimal | null | undefined,
): void {
  if (valorRemoto === null || valorRemoto === undefined) {
    throw new Error('Camada1 sem valor remoto — crédito recusado');
  }
  if (valorRemoto.minus(valorBrutoLocal).abs().gt(TOLERANCIA)) {
    throw new Error(
      `Camada1 valor divergente: remoto=${valorRemoto.toFixed(2)} ` +
        `local=${valorBrutoLocal.toFixed(2)}`,
    );
  }
}
