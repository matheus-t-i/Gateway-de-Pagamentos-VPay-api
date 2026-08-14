import { TIPOS_EMAIL, TipoEmail } from '../shared';

export type ConteudoEmail = { assunto: string; texto: string; html: string };

/** Identidade usada nos e-mails — espelha o brand.ts do painel. */
export const MARCA = {
  nome: process.env.BRAND_NOME ?? 'VPay',
  site: process.env.BRAND_SITE ?? 'https://vpay.com.br',
  email: process.env.BRAND_EMAIL ?? 'contato@vpay.com.br',
  whatsapp: process.env.BRAND_WHATSAPP ?? '+55 (11) 99999-9999',
};

const ENTIDADES_HTML: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapa valores controláveis por usuário/admin antes de entrar no HTML do
 * e-mail. Os templates montam o corpo por interpolação de string e o
 * `<strong>`/`<br>` literal escrito AQUI é confiável — o que NÃO pode entrar cru
 * é o dado vindo de fora: `nome` (`nomeRazaoSocial`, sem restrição de caractere
 * no cadastro público), `motivo` (digitado pelo admin) e `chave`. Sem isto, um
 * cadastro com `<a>`/`<img onerror=…>` no nome injeta HTML na caixa do
 * destinatário. Só o corpo HTML é escapado; a versão `text/plain` (`texto`) fica
 * crua de propósito — lá `<` não é markup.
 */
const esc = (valor: string | undefined): string =>
  (valor ?? '').replace(/[&<>"']/g, (c) => ENTIDADES_HTML[c]);

/**
 * URL de CTA: hoje é sempre montada pelo servidor (WEB_URL + token), mas cai num
 * `href` — validar o esquema (só http/https) fecha `javascript:` e escapar as
 * aspas impede quebrar o atributo. Defesa em profundidade barata.
 */
const urlSegura = (u: string): string => {
  try {
    const { protocol } = new URL(u);
    if (protocol !== 'http:' && protocol !== 'https:') return '#';
  } catch {
    return '#';
  }
  return esc(u);
};

function layout(titulo: string, corpo: string, cta?: { texto: string; url: string }) {
  // `cta.url` é o único dado externo aqui; `titulo` e `cta.texto` são literais do
  // código (o `assunto` de cada case), por isso não passam por `esc`.
  const url = cta ? urlSegura(cta.url) : '';
  const botao = cta
    ? `<p style="margin:28px 0"><a href="${url}" style="background:#0f766e;color:#ecfdf5;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;font-weight:600">${cta.texto}</a></p>
       <p style="font-size:12px;color:#64748b">Se o botão não funcionar, copie e cole este endereço no navegador:<br>${url}</p>`
    : '';
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0f172a">
  <p style="font-size:26px;font-weight:700;color:#0f766e;margin:0 0 24px">${MARCA.nome}</p>
  <h1 style="font-size:20px;margin:0 0 12px">${titulo}</h1>
  ${corpo}
  ${botao}
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0 16px">
  <p style="font-size:12px;color:#64748b;margin:0">
    Dúvidas: <a href="mailto:${MARCA.email}" style="color:#0f766e">${MARCA.email}</a> · WhatsApp ${MARCA.whatsapp}<br>
    ${MARCA.site}
  </p>
</div>`;
}

const p = (t: string) => `<p style="margin:0 0 12px;line-height:1.6">${t}</p>`;

/**
 * Monta assunto/corpo de cada e-mail transacional.
 * `dados` traz as variáveis (link, motivo, etc.).
 */
export function montarEmail(
  tipo: TipoEmail,
  nome: string | undefined,
  dados: Record<string, string> = {},
): ConteudoEmail {
  // `ola` vai na versão text/plain (cru); `olaHtml` vai no corpo HTML (escapado).
  const ola = nome ? `Olá, ${nome}!` : 'Olá!';
  const olaHtml = nome ? `Olá, ${esc(nome)}!` : 'Olá!';

  switch (tipo) {
    case TIPOS_EMAIL.CADASTRO_RECEBIDO:
      return montar(
        `Bem-vindo à ${MARCA.nome}`,
        `${ola} Recebemos seu cadastro. O próximo passo é enviar sua documentação para análise.`,
        `${p(olaHtml)}${p('Recebemos seu cadastro na ' + MARCA.nome + '.')}${p('O próximo passo é enviar sua documentação para que possamos analisar sua conta.')}`,
        dados.url ? { texto: 'Enviar documentação', url: dados.url } : undefined,
      );

    case TIPOS_EMAIL.DOCUMENTACAO_EM_ANALISE:
      return montar(
        'Sua documentação está em análise',
        `${ola} Recebemos todos os documentos obrigatórios. Avisaremos assim que a análise terminar.`,
        `${p(olaHtml)}${p('Recebemos todos os documentos obrigatórios e sua conta entrou em análise.')}${p('Você será avisado por e-mail assim que a análise terminar.')}`,
      );

    case TIPOS_EMAIL.CONTA_APROVADA:
      return montar(
        'Sua conta foi aprovada 🎉',
        `${ola} Sua conta foi aprovada. Já pode acessar o painel.`,
        `${p(olaHtml)}${p('Boa notícia: sua conta foi aprovada e já está liberada para operar.')}`,
        dados.url ? { texto: 'Acessar o painel', url: dados.url } : undefined,
      );

    case TIPOS_EMAIL.CONTA_REPROVADA:
      return montar(
        'Sobre a análise do seu cadastro',
        `${ola} Seu cadastro não foi aprovado. Motivo: ${dados.motivo ?? 'não informado'}.`,
        `${p(olaHtml)}${p('Analisamos seu cadastro e não foi possível aprová-lo neste momento.')}${p('<strong>Motivo:</strong> ' + esc(dados.motivo ?? 'não informado'))}${p('Se acredita que houve um engano, responda este e-mail ou fale com o suporte.')}`,
      );

    case TIPOS_EMAIL.DOCUMENTO_INVALIDADO:
      return montar(
        'Precisamos que você reenvie um documento',
        `${ola} O documento ${dados.documento ?? ''} precisa ser reenviado. Motivo: ${dados.motivo ?? 'não informado'}.`,
        `${p(olaHtml)}${p('Um documento do seu cadastro não pôde ser validado e precisa ser reenviado.')}${p('<strong>Documento:</strong> ' + esc(dados.documento ?? '-'))}${p('<strong>Motivo:</strong> ' + esc(dados.motivo ?? 'não informado'))}`,
        dados.url ? { texto: 'Reenviar documento', url: dados.url } : undefined,
      );

    case TIPOS_EMAIL.REDEFINIR_SENHA:
      return montar(
        'Redefinição de senha',
        `${ola} Use este link para criar uma nova senha (validade de ${dados.validadeMinutos ?? '30'} minutos): ${dados.url ?? ''}`,
        `${p(olaHtml)}${p('Recebemos um pedido para redefinir a senha da sua conta.')}${p('O link vale por <strong>' + esc(dados.validadeMinutos ?? '30') + ' minutos</strong> e só pode ser usado uma vez.')}${p('Se não foi você que pediu, ignore este e-mail — sua senha continua a mesma.')}`,
        dados.url ? { texto: 'Criar nova senha', url: dados.url } : undefined,
      );

    case TIPOS_EMAIL.SENHA_ALTERADA:
      return montar(
        'Sua senha foi alterada',
        `${ola} A senha da sua conta acabou de ser alterada. Se não foi você, fale com o suporte imediatamente.`,
        `${p(olaHtml)}${p('A senha da sua conta acabou de ser alterada.')}${p('<strong>Se não foi você</strong>, fale com o suporte imediatamente.')}`,
      );

    case TIPOS_EMAIL.CONTA_ENCERRADA:
      return montar(
        'Sua conta foi encerrada',
        `${ola} Sua conta foi encerrada a seu pedido. O acesso ao painel, as credenciais de API e os webhooks foram desligados. O histórico das suas operações continua guardado.`,
        `${p(olaHtml)}${p('Sua conta foi <strong>encerrada</strong> a seu pedido.')}${p('O acesso ao painel, as credenciais de API e os webhooks foram desligados imediatamente.')}${p('Seu histórico de operações continua guardado — nada foi apagado. Para reabrir a conta, fale com o suporte.')}${p('<strong>Se não foi você</strong>, entre em contato imediatamente.')}`,
      );

    case TIPOS_EMAIL.TOTP_HABILITADO:
      return montar(
        'Verificação em duas etapas ativada',
        `${ola} A verificação em duas etapas foi ativada na sua conta.`,
        `${p(olaHtml)}${p('A verificação em duas etapas (2FA) foi ativada na sua conta. A partir de agora o código do aplicativo autenticador será pedido no login.')}${p('Se não foi você, fale com o suporte imediatamente.')}`,
      );

    case TIPOS_EMAIL.TOTP_DESABILITADO:
      return montar(
        'Verificação em duas etapas desativada',
        `${ola} A verificação em duas etapas foi desativada na sua conta.`,
        `${p(olaHtml)}${p('A verificação em duas etapas (2FA) foi <strong>desativada</strong> na sua conta.')}${p('Se não foi você, fale com o suporte imediatamente.')}`,
      );

    case TIPOS_EMAIL.CHAVE_PIX_APROVADA:
      return montar(
        'Chave PIX aprovada',
        `${ola} A chave PIX ${dados.chave ?? ''} foi aprovada e já pode ser usada para saques.`,
        `${p(olaHtml)}${p('A chave PIX <strong>' + esc(dados.chave ?? '') + '</strong> foi aprovada e já pode ser usada para saques pelo painel.')}`,
      );

    case TIPOS_EMAIL.CHAVE_PIX_REPROVADA:
      return montar(
        'Chave PIX não aprovada',
        `${ola} A chave PIX ${dados.chave ?? ''} não foi aprovada. Motivo: ${dados.motivo ?? 'não informado'}.`,
        `${p(olaHtml)}${p('A chave PIX <strong>' + esc(dados.chave ?? '') + '</strong> não foi aprovada.')}${p('<strong>Motivo:</strong> ' + esc(dados.motivo ?? 'não informado'))}`,
      );

    case TIPOS_EMAIL.CHAVE_PIX_REVOGADA:
      return montar(
        'Chave PIX desativada',
        `${ola} A chave PIX ${dados.chave ?? ''} foi desativada e não pode mais ser usada para saques. Motivo: ${dados.motivo ?? 'não informado'}.`,
        `${p(olaHtml)}${p('A chave PIX <strong>' + esc(dados.chave ?? '') + '</strong> foi desativada e <strong>não pode mais ser usada para saques</strong>.')}${p('<strong>Motivo:</strong> ' + esc(dados.motivo ?? 'não informado'))}${p('Se precisar usá-la de novo, cadastre a chave outra vez no painel — ela passará por uma nova análise.')}`,
      );

    case TIPOS_EMAIL.MED_RECEBIDO:
      return montar(
        'Contestação recebida (MED)',
        `${ola} Recebemos uma contestação de R$ ${dados.valor ?? ''} referente à transação ${dados.idTransacao ?? ''}.`,
        `${p(olaHtml)}${p('Recebemos uma contestação (MED) referente a uma transação da sua conta.')}${p('<strong>Valor:</strong> R$ ' + esc(dados.valor ?? '') + '<br><strong>Transação:</strong> ' + esc(dados.idTransacao ?? ''))}${p(dados.modo === 'BLOQUEAR_SALDO' ? 'O valor foi bloqueado no seu saldo enquanto a contestação é analisada.' : dados.modo === 'DEBITAR_IMEDIATAMENTE' ? 'O valor foi debitado do seu saldo conforme a política da sua conta.' : 'O caso entrou em análise pela nossa equipe.')}`,
      );

    case TIPOS_EMAIL.MED_ACEITO:
      return montar(
        'Contestação aceita — valor devolvido',
        `${ola} A contestação de R$ ${dados.valor ?? ''} foi aceita e o valor será devolvido ao pagador.`,
        `${p(olaHtml)}${p('A contestação (MED) da transação <strong>' + esc(dados.idTransacao ?? '') + '</strong> foi aceita.')}${p('<strong>Valor devolvido:</strong> R$ ' + esc(dados.valor ?? ''))}${dados.motivo ? p('<strong>Observação:</strong> ' + esc(dados.motivo)) : ''}`,
      );

    case TIPOS_EMAIL.MED_RECUSADO:
      return montar(
        'Contestação recusada — valor liberado',
        `${ola} A contestação de R$ ${dados.valor ?? ''} foi recusada e o valor voltou ao seu saldo.`,
        `${p(olaHtml)}${p('A contestação (MED) da transação <strong>' + esc(dados.idTransacao ?? '') + '</strong> foi recusada.')}${p('Se havia valor bloqueado, ele já voltou para o seu saldo disponível.')}${dados.motivo ? p('<strong>Motivo:</strong> ' + esc(dados.motivo)) : ''}`,
      );

    default:
      return montar(
        `Notificação ${MARCA.nome}`,
        `${ola} Você tem uma nova notificação.`,
        `${p(olaHtml)}${p('Você tem uma nova notificação na sua conta.')}`,
      );
  }
}

function montar(
  assunto: string,
  texto: string,
  corpoHtml: string,
  cta?: { texto: string; url: string },
): ConteudoEmail {
  return {
    assunto: `${assunto} — ${MARCA.nome}`,
    texto,
    html: layout(assunto, corpoHtml, cta),
  };
}
