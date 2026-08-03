import { TIPOS_EMAIL, TipoEmail } from '../shared';

export type ConteudoEmail = { assunto: string; texto: string; html: string };

/** Identidade usada nos e-mails — espelha o brand.ts do painel. */
export const MARCA = {
  nome: process.env.BRAND_NOME ?? 'VPay',
  site: process.env.BRAND_SITE ?? 'https://vpay.com.br',
  email: process.env.BRAND_EMAIL ?? 'contato@vpay.com.br',
  whatsapp: process.env.BRAND_WHATSAPP ?? '+55 (11) 99999-9999',
};

function layout(titulo: string, corpo: string, cta?: { texto: string; url: string }) {
  const botao = cta
    ? `<p style="margin:28px 0"><a href="${cta.url}" style="background:#0f766e;color:#ecfdf5;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;font-weight:600">${cta.texto}</a></p>
       <p style="font-size:12px;color:#64748b">Se o botão não funcionar, copie e cole este endereço no navegador:<br>${cta.url}</p>`
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
  const ola = nome ? `Olá, ${nome}!` : 'Olá!';

  switch (tipo) {
    case TIPOS_EMAIL.CADASTRO_RECEBIDO:
      return montar(
        `Bem-vindo à ${MARCA.nome}`,
        `${ola} Recebemos seu cadastro. O próximo passo é enviar sua documentação para análise.`,
        `${p(ola)}${p('Recebemos seu cadastro na ' + MARCA.nome + '.')}${p('O próximo passo é enviar sua documentação para que possamos analisar sua conta.')}`,
        dados.url ? { texto: 'Enviar documentação', url: dados.url } : undefined,
      );

    case TIPOS_EMAIL.DOCUMENTACAO_EM_ANALISE:
      return montar(
        'Sua documentação está em análise',
        `${ola} Recebemos todos os documentos obrigatórios. Avisaremos assim que a análise terminar.`,
        `${p(ola)}${p('Recebemos todos os documentos obrigatórios e sua conta entrou em análise.')}${p('Você será avisado por e-mail assim que a análise terminar.')}`,
      );

    case TIPOS_EMAIL.CONTA_APROVADA:
      return montar(
        'Sua conta foi aprovada 🎉',
        `${ola} Sua conta foi aprovada. Já pode acessar o painel.`,
        `${p(ola)}${p('Boa notícia: sua conta foi aprovada e já está liberada para operar.')}`,
        dados.url ? { texto: 'Acessar o painel', url: dados.url } : undefined,
      );

    case TIPOS_EMAIL.CONTA_REPROVADA:
      return montar(
        'Sobre a análise do seu cadastro',
        `${ola} Seu cadastro não foi aprovado. Motivo: ${dados.motivo ?? 'não informado'}.`,
        `${p(ola)}${p('Analisamos seu cadastro e não foi possível aprová-lo neste momento.')}${p('<strong>Motivo:</strong> ' + (dados.motivo ?? 'não informado'))}${p('Se acredita que houve um engano, responda este e-mail ou fale com o suporte.')}`,
      );

    case TIPOS_EMAIL.DOCUMENTO_INVALIDADO:
      return montar(
        'Precisamos que você reenvie um documento',
        `${ola} O documento ${dados.documento ?? ''} precisa ser reenviado. Motivo: ${dados.motivo ?? 'não informado'}.`,
        `${p(ola)}${p('Um documento do seu cadastro não pôde ser validado e precisa ser reenviado.')}${p('<strong>Documento:</strong> ' + (dados.documento ?? '-'))}${p('<strong>Motivo:</strong> ' + (dados.motivo ?? 'não informado'))}`,
        dados.url ? { texto: 'Reenviar documento', url: dados.url } : undefined,
      );

    case TIPOS_EMAIL.REDEFINIR_SENHA:
      return montar(
        'Redefinição de senha',
        `${ola} Use este link para criar uma nova senha (validade de ${dados.validadeMinutos ?? '30'} minutos): ${dados.url ?? ''}`,
        `${p(ola)}${p('Recebemos um pedido para redefinir a senha da sua conta.')}${p('O link vale por <strong>' + (dados.validadeMinutos ?? '30') + ' minutos</strong> e só pode ser usado uma vez.')}${p('Se não foi você que pediu, ignore este e-mail — sua senha continua a mesma.')}`,
        dados.url ? { texto: 'Criar nova senha', url: dados.url } : undefined,
      );

    case TIPOS_EMAIL.SENHA_ALTERADA:
      return montar(
        'Sua senha foi alterada',
        `${ola} A senha da sua conta acabou de ser alterada. Se não foi você, fale com o suporte imediatamente.`,
        `${p(ola)}${p('A senha da sua conta acabou de ser alterada.')}${p('<strong>Se não foi você</strong>, fale com o suporte imediatamente.')}`,
      );

    case TIPOS_EMAIL.TOTP_HABILITADO:
      return montar(
        'Verificação em duas etapas ativada',
        `${ola} A verificação em duas etapas foi ativada na sua conta.`,
        `${p(ola)}${p('A verificação em duas etapas (2FA) foi ativada na sua conta. A partir de agora o código do aplicativo autenticador será pedido no login.')}${p('Se não foi você, fale com o suporte imediatamente.')}`,
      );

    case TIPOS_EMAIL.TOTP_DESABILITADO:
      return montar(
        'Verificação em duas etapas desativada',
        `${ola} A verificação em duas etapas foi desativada na sua conta.`,
        `${p(ola)}${p('A verificação em duas etapas (2FA) foi <strong>desativada</strong> na sua conta.')}${p('Se não foi você, fale com o suporte imediatamente.')}`,
      );

    case TIPOS_EMAIL.CHAVE_PIX_APROVADA:
      return montar(
        'Chave PIX aprovada',
        `${ola} A chave PIX ${dados.chave ?? ''} foi aprovada e já pode ser usada para saques.`,
        `${p(ola)}${p('A chave PIX <strong>' + (dados.chave ?? '') + '</strong> foi aprovada e já pode ser usada para saques pelo painel.')}`,
      );

    case TIPOS_EMAIL.CHAVE_PIX_REPROVADA:
      return montar(
        'Chave PIX não aprovada',
        `${ola} A chave PIX ${dados.chave ?? ''} não foi aprovada. Motivo: ${dados.motivo ?? 'não informado'}.`,
        `${p(ola)}${p('A chave PIX <strong>' + (dados.chave ?? '') + '</strong> não foi aprovada.')}${p('<strong>Motivo:</strong> ' + (dados.motivo ?? 'não informado'))}`,
      );

    case TIPOS_EMAIL.MED_RECEBIDO:
      return montar(
        'Contestação recebida (MED)',
        `${ola} Recebemos uma contestação de R$ ${dados.valor ?? ''} referente à transação ${dados.idTransacao ?? ''}.`,
        `${p(ola)}${p('Recebemos uma contestação (MED) referente a uma transação da sua conta.')}${p('<strong>Valor:</strong> R$ ' + (dados.valor ?? '') + '<br><strong>Transação:</strong> ' + (dados.idTransacao ?? ''))}${p(dados.modo === 'BLOQUEAR_SALDO' ? 'O valor foi bloqueado no seu saldo enquanto a contestação é analisada.' : dados.modo === 'DEBITAR_IMEDIATAMENTE' ? 'O valor foi debitado do seu saldo conforme a política da sua conta.' : 'O caso entrou em análise pela nossa equipe.')}`,
      );

    case TIPOS_EMAIL.MED_ACEITO:
      return montar(
        'Contestação aceita — valor devolvido',
        `${ola} A contestação de R$ ${dados.valor ?? ''} foi aceita e o valor será devolvido ao pagador.`,
        `${p(ola)}${p('A contestação (MED) da transação <strong>' + (dados.idTransacao ?? '') + '</strong> foi aceita.')}${p('<strong>Valor devolvido:</strong> R$ ' + (dados.valor ?? ''))}${dados.motivo ? p('<strong>Observação:</strong> ' + dados.motivo) : ''}`,
      );

    case TIPOS_EMAIL.MED_RECUSADO:
      return montar(
        'Contestação recusada — valor liberado',
        `${ola} A contestação de R$ ${dados.valor ?? ''} foi recusada e o valor voltou ao seu saldo.`,
        `${p(ola)}${p('A contestação (MED) da transação <strong>' + (dados.idTransacao ?? '') + '</strong> foi recusada.')}${p('Se havia valor bloqueado, ele já voltou para o seu saldo disponível.')}${dados.motivo ? p('<strong>Motivo:</strong> ' + dados.motivo) : ''}`,
      );

    default:
      return montar(
        `Notificação ${MARCA.nome}`,
        `${ola} Você tem uma nova notificação.`,
        `${p(ola)}${p('Você tem uma nova notificação na sua conta.')}`,
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
