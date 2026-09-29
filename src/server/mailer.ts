const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function emailDeliveryConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM && process.env.PUBLIC_APP_URL);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] ?? character);
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const publicUrl = process.env.PUBLIC_APP_URL;
  if (!apiKey || !from || !publicUrl) throw new Error('EMAIL_NOT_CONFIGURED');

  const resetUrl = `${publicUrl}/?reset=${encodeURIComponent(token)}`;
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Redefinição de senha do TelaHub',
      text: `Recebemos uma solicitação para redefinir sua senha do TelaHub. Abra este link em até 30 minutos: ${resetUrl}\n\nSe você não solicitou isso, ignore este e-mail.`,
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#172033;max-width:560px"><h2>Redefinição de senha</h2><p>Recebemos uma solicitação para redefinir sua senha do TelaHub.</p><p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#766cff;color:#fff;text-decoration:none">Redefinir minha senha</a></p><p>Este link expira em 30 minutos e pode ser usado uma única vez.</p><p style="color:#65718a;font-size:13px">Se você não solicitou isso, ignore este e-mail.</p></div>`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240);
    throw new Error(`RESEND_FAILED_${response.status}:${detail}`);
  }
}
