/**
 * Rótulo curto da venda para as listagens (coluna "Produto"), compartilhado
 * pelos relatórios do admin e pelo extrato do lojista — o mesmo registro não
 * pode aparecer com nome diferente dependendo da tela.
 *
 * Com vários itens mostra o primeiro e quantos mais existem; a lista completa
 * fica no detalhe da linha. Sem itens (depósito pelo painel ou cobrança
 * anterior ao modelo de produtos), cai na referência externa.
 */
export function resumoProduto(
  itens: Array<{ titulo: string }>,
  referenciaExterna: string | null,
): string {
  if (itens.length === 1) return itens[0].titulo;
  if (itens.length > 1) return `${itens[0].titulo} +${itens.length - 1}`;
  return referenciaExterna ?? '—';
}
