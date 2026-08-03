import Decimal from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export function money(value: string | number | Decimal): Decimal {
  return new Decimal(value);
}

export function moneyToString(value: Decimal, places = 2): string {
  return value.toFixed(places);
}

/** tarifa = valor * percentual/100 + fixa */
export function calcTarifa(
  valorBruto: Decimal,
  percentual: Decimal,
  fixa: Decimal,
): Decimal {
  return valorBruto.mul(percentual).div(100).plus(fixa).toDecimalPlaces(2);
}

export function calcReserva(
  base: Decimal,
  percentual: Decimal,
): Decimal {
  return base.mul(percentual).div(100).toDecimalPlaces(2);
}
