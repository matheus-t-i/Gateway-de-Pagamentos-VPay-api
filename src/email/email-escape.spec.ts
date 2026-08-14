import { montarEmail } from './email.templates';
import { TIPOS_EMAIL } from '../shared';

/**
 * Injeção de HTML nos e-mails transacionais (achado BAIXA da auditoria de
 * segurança, ago/2026). O corpo HTML era montado por interpolação crua, então
 * `nomeRazaoSocial` (sem restrição de caractere no cadastro público) e o
 * `motivo` digitado pelo admin entravam como HTML na caixa do destinatário.
 *
 * Regra: dado externo é escapado NO CORPO HTML e fica CRU na versão text/plain
 * (lá `<` não é markup). O `<strong>`/`<br>` que o template escreve é confiável
 * e não pode ser escapado — senão o negrito viraria texto literal.
 */
describe('montarEmail — escape de dado controlável no HTML', () => {
  it('escapa nome malicioso no HTML e o mantém cru no text/plain', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const email = montarEmail(TIPOS_EMAIL.CADASTRO_RECEBIDO, payload, {});

    // HTML: a tag não pode chegar executável.
    expect(email.html).not.toContain('<img src=x onerror');
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // text/plain não é HTML — fica cru de propósito.
    expect(email.texto).toContain(payload);
  });

  it('escapa o motivo digitado pelo admin (fronteira admin→cliente)', () => {
    const email = montarEmail(TIPOS_EMAIL.CONTA_REPROVADA, 'Loja', {
      motivo: '<script>steal()</script>',
    });
    expect(email.html).not.toContain('<script>steal()');
    expect(email.html).toContain('&lt;script&gt;steal()&lt;/script&gt;');
  });

  it('escapa a chave PIX e o motivo na revogação', () => {
    const email = montarEmail(TIPOS_EMAIL.CHAVE_PIX_REVOGADA, 'Loja', {
      chave: '"><b>x</b>',
      motivo: '<i>y</i>',
    });
    expect(email.html).not.toContain('<b>x</b>');
    expect(email.html).not.toContain('<i>y</i>');
    expect(email.html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('preserva a marcação confiável (<strong>) do próprio template', () => {
    const email = montarEmail(TIPOS_EMAIL.CONTA_REPROVADA, 'Loja', {
      motivo: 'documento ilegível',
    });
    // O rótulo em negrito é do template, não do dado — continua HTML real.
    expect(email.html).toContain('<strong>Motivo:</strong> documento ilegível');
  });

  it('neutraliza URL de CTA com esquema perigoso e preserva https', () => {
    const perigosa = montarEmail(TIPOS_EMAIL.REDEFINIR_SENHA, 'Loja', {
      url: 'javascript:alert(1)',
    });
    expect(perigosa.html).not.toContain('javascript:alert(1)');
    expect(perigosa.html).toContain('href="#"');

    const ok = montarEmail(TIPOS_EMAIL.REDEFINIR_SENHA, 'Loja', {
      url: 'https://painel.vpay.com.br/senha/redefinir?token=abc',
    });
    expect(ok.html).toContain('href="https://painel.vpay.com.br/senha/redefinir?token=abc"');
  });

  it('não injeta "undefined"/"null" quando o nome falta', () => {
    const email = montarEmail(TIPOS_EMAIL.CADASTRO_RECEBIDO, undefined, {});
    expect(email.html).toContain('Olá!');
    expect(email.html).not.toContain('undefined');
  });
});
