const nodemailer = require('nodemailer');
const {
  smtpHost,
  smtpPort,
  smtpUser,
  smtpPass,
  smtpFrom,
  emailEnabled,
} = require('../config/env');

let transporter;

function getTransporter() {
  if (!emailEnabled) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html, headers = {} }) {
  const transport = getTransporter();
  if (!transport) {
    console.warn('[email] SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in backend/.env');
    return { sent: false, reason: 'smtp_not_configured' };
  }

  try {
    await transport.sendMail({
      from: smtpFrom,
      to,
      subject,
      text,
      html,
      headers: {
        'X-Auto-Response-Suppress': 'OOF, AutoReply',
        ...headers,
      },
    });
    return { sent: true };
  } catch (err) {
    console.error('[email] Failed to send:', err.message);
    return { sent: false, reason: err.message };
  }
}

async function sendInstructorInviteEmail({ to, institutionName, personalMessage }) {
  const subject = `${institutionName} invited you to join their staff on Fitnexia`;
  const messageBlock = personalMessage
    ? `\n\nMessage from ${institutionName}:\n"${personalMessage}"`
    : '';

  const text = [
    'Hi,',
    '',
    `${institutionName} has invited you to join their gym staff on Fitnexia.${messageBlock}`,
    '',
    `Sign in to the Fitnexia app with ${to} and open your dashboard to accept the invite.`,
    '',
    '— Fitnexia',
  ].join('\n');

  const html = `
    <p>Hi,</p>
    <p><strong>${institutionName}</strong> has invited you to join their gym staff on Fitnexia.</p>
    ${personalMessage ? `<p><em>Message from ${institutionName}:</em><br>"${escapeHtml(personalMessage)}"</p>` : ''}
    <p>Sign in to the Fitnexia app with <strong>${escapeHtml(to)}</strong> and open your dashboard to accept the invite.</p>
    <p>— Fitnexia</p>
  `;

  return sendMail({ to, subject, text, html });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMoney(amountCents, currency) {
  const amount = amountCents / 100;
  try {
    return new Intl.NumberFormat('es-UY', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

async function sendPaymentReceiptEmails({
  athleteEmail,
  instructorEmail,
  classTitle,
  classStartAt,
  grossCents,
  currency,
  commissionPercent,
  bookingId,
}) {
  const gross = formatMoney(grossCents, currency);
  const platformFeeCents = Math.round(grossCents * (commissionPercent / 100));
  const netCents = grossCents - platformFeeCents;
  const platformFee = formatMoney(platformFeeCents, currency);
  const net = formatMoney(netCents, currency);
  const when = classStartAt
    ? new Date(classStartAt).toLocaleString('es-UY', { dateStyle: 'medium', timeStyle: 'short' })
    : '';

  const athleteSubject = `Fitnexia — Pago confirmado: ${classTitle}`;
  const athleteText = [
    'Tu pago fue confirmado.',
    '',
    `Clase: ${classTitle}`,
    when ? `Fecha: ${when}` : '',
    `Monto: ${gross}`,
    `Reserva: ${bookingId}`,
    '',
    '— Fitnexia',
  ]
    .filter(Boolean)
    .join('\n');

  const instructorSubject = `Fitnexia — Nueva reserva pagada: ${classTitle}`;
  const instructorText = [
    'Un atleta reservó y pagó tu clase.',
    '',
    `Clase: ${classTitle}`,
    when ? `Fecha: ${when}` : '',
    `Monto bruto: ${gross}`,
    `Comisión Fitnexia (${commissionPercent}%): ${platformFee}`,
    `Tu ingreso neto: ${net}`,
    `Reserva: ${bookingId}`,
    '',
    '— Fitnexia',
  ]
    .filter(Boolean)
    .join('\n');

  const results = await Promise.all([
    sendMail({ to: athleteEmail, subject: athleteSubject, text: athleteText }),
    sendMail({ to: instructorEmail, subject: instructorSubject, text: instructorText }),
  ]);

  return {
    athlete: results[0],
    instructor: results[1],
  };
}

async function sendPasswordResetEmail({ to, webResetUrl, appResetUrl, expiresMinutes }) {
  const subject = 'Restablece tu contraseña de Fitnexia';
  const safeWeb = escapeHtml(webResetUrl);
  const safeApp = escapeHtml(appResetUrl);

  const text = [
    'Hola,',
    '',
    'Recibimos una solicitud para restablecer la contraseña de tu cuenta Fitnexia.',
    '',
    `Abrí este enlace en tu celular (vence en ${expiresMinutes} minutos):`,
    webResetUrl,
    '',
    'Si el enlace no abre la app automáticamente, copiá y pegá este enlace en el navegador del teléfono:',
    appResetUrl,
    '',
    'Si no pediste este cambio, podés ignorar este email. Tu contraseña no cambiará.',
    '',
    '— Fitnexia',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px 28px;">
          <tr>
            <td>
              <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181b;">Fitnexia</p>
              <p style="margin:0 0 20px;font-size:15px;line-height:22px;color:#52525b;">
                Recibimos una solicitud para restablecer la contraseña de <strong>${escapeHtml(to)}</strong>.
              </p>
              <p style="margin:0 0 24px;font-size:15px;line-height:22px;color:#52525b;">
                Tocá el botón para elegir una contraseña nueva. El enlace vence en ${expiresMinutes} minutos.
              </p>
              <p style="margin:0 0 28px;text-align:center;">
                <a href="${safeWeb}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 24px;border-radius:8px;">
                  Restablecer contraseña
                </a>
              </p>
              <p style="margin:0 0 12px;font-size:13px;line-height:20px;color:#71717a;">
                Si el botón no funciona, copiá este enlace en el navegador de tu celular:
              </p>
              <p style="margin:0 0 24px;font-size:13px;line-height:20px;word-break:break-all;">
                <a href="${safeWeb}" style="color:#2563eb;">${safeWeb}</a>
              </p>
              <p style="margin:0;font-size:13px;line-height:20px;color:#71717a;">
                Si no pediste este cambio, podés ignorar este email. Tu contraseña no cambiará.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return sendMail({ to, subject, text, html });
}

function buildPasswordResetAppLinks({ token, scheme, androidPackage }) {
  const query = `token=${encodeURIComponent(token)}`;
  return {
    appResetUrl: `${scheme}:///reset-password?${query}`,
    androidIntentUrl: `intent://reset-password?${query}#Intent;scheme=${scheme};package=${androidPackage};end`,
  };
}

function renderPasswordResetOpenPage({
  token,
  apiPublicUrl,
  appResetUrl,
  androidIntentUrl,
  expiresMinutes,
}) {
  const safeToken = escapeHtml(token);
  const safeApp = escapeHtml(appResetUrl);
  const safeIntent = escapeHtml(androidIntentUrl);
  const resetApiUrl = `${apiPublicUrl}/v1/auth/reset-password`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Restablecer contraseña — Fitnexia</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px 16px 40px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f4f4f5;
      color: #18181b;
    }
    .card {
      max-width: 420px;
      margin: 0 auto;
      background: #fff;
      border-radius: 12px;
      padding: 28px 24px;
      box-shadow: 0 1px 3px rgba(0,0,0,.08);
    }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { font-size: 15px; line-height: 22px; color: #52525b; margin: 0 0 16px; }
    label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 6px; color: #3f3f46; }
    input {
      width: 100%;
      padding: 12px 14px;
      border: 1px solid #d4d4d8;
      border-radius: 8px;
      font-size: 16px;
      margin-bottom: 14px;
    }
    button, .btn {
      display: block;
      width: 100%;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      padding: 14px 16px;
      cursor: pointer;
      text-align: center;
      text-decoration: none;
    }
    .btn-primary { background: #2563eb; color: #fff; margin-bottom: 12px; }
    .btn-secondary { background: #f4f4f5; color: #18181b; border: 1px solid #d4d4d8; }
    .hint { font-size: 13px; color: #71717a; margin-top: 16px; }
    .error { color: #dc2626; font-size: 14px; margin-bottom: 12px; display: none; }
    .success { color: #16a34a; font-size: 15px; display: none; }
    .divider { border: 0; border-top: 1px solid #e4e4e7; margin: 24px 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Nueva contraseña</h1>
    <p>Elegí una contraseña nueva para tu cuenta Fitnexia.</p>

    <div id="form-section">
      <p id="error" class="error"></p>
      <form id="reset-form">
        <input type="hidden" name="token" value="${safeToken}" />
        <label for="password">Contraseña nueva</label>
        <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8" />
        <label for="confirm">Confirmar contraseña</label>
        <input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength="8" />
        <button type="submit" class="btn-primary">Guardar contraseña</button>
      </form>
    </div>

    <p id="success" class="success"></p>

    <hr class="divider" />

    <p>¿Preferís usar la app?</p>
    <button type="button" id="open-app" class="btn-secondary">Abrir Fitnexia</button>
    <p class="hint">El enlace vence en ${expiresMinutes} minutos.</p>
  </div>

  <script>
    (function () {
      var token = ${JSON.stringify(token)};
      var appUrl = ${JSON.stringify(appResetUrl)};
      var intentUrl = ${JSON.stringify(androidIntentUrl)};
      var resetApiUrl = ${JSON.stringify(resetApiUrl)};
      var isAndroid = /Android/i.test(navigator.userAgent);

      function openApp() {
        window.location.href = isAndroid ? intentUrl : appUrl;
      }

      document.getElementById('open-app').addEventListener('click', openApp);

      document.getElementById('reset-form').addEventListener('submit', async function (event) {
        event.preventDefault();
        var errorEl = document.getElementById('error');
        var successEl = document.getElementById('success');
        var formSection = document.getElementById('form-section');
        var password = document.getElementById('password').value;
        var confirm = document.getElementById('confirm').value;

        errorEl.style.display = 'none';
        successEl.style.display = 'none';

        if (password.length < 8) {
          errorEl.textContent = 'La contraseña debe tener al menos 8 caracteres.';
          errorEl.style.display = 'block';
          return;
        }
        if (password !== confirm) {
          errorEl.textContent = 'Las contraseñas no coinciden.';
          errorEl.style.display = 'block';
          return;
        }

        try {
          var response = await fetch(resetApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token, password: password }),
          });
          if (!response.ok) {
            var body = await response.json().catch(function () { return {}; });
            throw new Error(
              (body.error && body.error.message) || body.message || 'No se pudo restablecer la contraseña.',
            );
          }
          formSection.style.display = 'none';
          successEl.textContent = 'Contraseña actualizada. Ya podés iniciar sesión en la app.';
          successEl.style.display = 'block';
        } catch (err) {
          errorEl.textContent = err.message || 'Ocurrió un error. Pedí un enlace nuevo.';
          errorEl.style.display = 'block';
        }
      });
    })();
  </script>
</body>
</html>`;
}

async function sendMembershipInviteEmail({ to, institutionName, planName, inviteCode, joinLink }) {
  const subject = `${institutionName} te invitó a unirte como socio`;
  const linkLine = joinLink ? `Enlace directo: ${joinLink}` : '';
  const text = [
    'Hola,',
    '',
    `${institutionName} te invitó a unirte con el plan "${planName}".`,
    '',
    `Código de invitación: ${inviteCode}`,
    linkLine,
    '',
    'Abrí la app Fitnexia, andá a Membresía del club e ingresá el código o el enlace.',
    '',
    '— Fitnexia',
  ]
    .filter(Boolean)
    .join('\n');
  const html = `
    <p>Hola,</p>
    <p><strong>${escapeHtml(institutionName)}</strong> te invitó a unirte con el plan <strong>${escapeHtml(planName)}</strong>.</p>
    <p>Código de invitación: <strong>${escapeHtml(inviteCode)}</strong></p>
    ${joinLink ? `<p><a href="${escapeHtml(joinLink)}">Abrir invitación en Fitnexia</a></p>` : ''}
    <p>Abrí la app Fitnexia, andá a Membresía del club e ingresá el código o el enlace.</p>
    <p>— Fitnexia</p>
  `;
  return sendMail({ to, subject, text, html });
}

async function sendMembershipDueReminderEmail({ to, institutionName, planName, dueDate }) {
  const when = dueDate
    ? new Date(dueDate).toLocaleDateString('es-UY', { dateStyle: 'long' })
    : 'próximamente';
  const subject = `Recordatorio: cuota de ${institutionName}`;
  const text = [
    'Hola,',
    '',
    `Tu cuota del plan "${planName}" en ${institutionName} vence el ${when}.`,
    '',
    'Revisá tu estado de cuenta en la app Fitnexia.',
    '',
    '— Fitnexia',
  ].join('\n');
  const html = `
    <p>Hola,</p>
    <p>Tu cuota del plan <strong>${escapeHtml(planName)}</strong> en <strong>${escapeHtml(institutionName)}</strong> vence el <strong>${escapeHtml(when)}</strong>.</p>
    <p>Revisá tu estado de cuenta en la app Fitnexia.</p>
    <p>— Fitnexia</p>
  `;
  return sendMail({ to, subject, text, html });
}

async function sendMembershipOverdueEmail({ to, institutionName }) {
  const subject = `Cuota vencida — ${institutionName}`;
  const text = [
    'Hola,',
    '',
    `Tu cuota en ${institutionName} está vencida. Regularizá tu pago desde la app Fitnexia.`,
    '',
    '— Fitnexia',
  ].join('\n');
  const html = `
    <p>Hola,</p>
    <p>Tu cuota en <strong>${escapeHtml(institutionName)}</strong> está vencida. Regularizá tu pago desde la app Fitnexia.</p>
    <p>— Fitnexia</p>
  `;
  return sendMail({ to, subject, text, html });
}

async function sendMembershipPaymentReceiptEmail({
  to,
  institutionName,
  planName,
  amountCents,
  currency,
}) {
  const amount = (amountCents / 100).toFixed(2);
  const subject = `Recibo de cuota — ${institutionName}`;
  const text = [
    'Hola,',
    '',
    `Recibimos tu pago de ${amount} ${currency} por el plan "${planName}" en ${institutionName}.`,
    '',
    '— Fitnexia',
  ].join('\n');
  const html = `
    <p>Hola,</p>
    <p>Recibimos tu pago de <strong>${amount} ${escapeHtml(currency)}</strong> por el plan <strong>${escapeHtml(planName)}</strong> en <strong>${escapeHtml(institutionName)}</strong>.</p>
    <p>— Fitnexia</p>
  `;
  return sendMail({ to, subject, text, html });
}

async function sendMembershipArrearsAlertEmail({ to, institutionName, overdueCount }) {
  const subject = `${overdueCount} socio(s) en mora — ${institutionName}`;
  const text = [
    'Hola,',
    '',
    `Tenés ${overdueCount} socio(s) con cuotas vencidas en ${institutionName}.`,
    'Revisá el registro de socios en la app Fitnexia.',
    '',
    '— Fitnexia',
  ].join('\n');
  const html = `
    <p>Hola,</p>
    <p>Tenés <strong>${overdueCount}</strong> socio(s) con cuotas vencidas en <strong>${escapeHtml(institutionName)}</strong>.</p>
    <p>Revisá el registro de socios en la app Fitnexia.</p>
    <p>— Fitnexia</p>
  `;
  return sendMail({ to, subject, text, html });
}

async function sendVerificationReceivedEmail({ to, displayName, businessDays }) {
  const subject = 'Recibimos tu solicitud de verificación — Fitnexia';
  const text = [
    `Hola ${displayName},`,
    '',
    'Recibimos tu solicitud de verificación de perfil.',
    `Te notificaremos dentro de ${businessDays} días hábiles.`,
    '',
    '— Fitnexia',
  ].join('\n');
  const html = `
    <p>Hola ${escapeHtml(displayName)},</p>
    <p>Recibimos tu solicitud de verificación de perfil.</p>
    <p>Te notificaremos dentro de <strong>${businessDays} días hábiles</strong>.</p>
    <p>— Fitnexia</p>
  `;
  return sendMail({ to, subject, text, html });
}

async function sendVerificationApprovedEmail({ to, displayName }) {
  const subject = '¡Perfil verificado! — Fitnexia';
  const text = [
    `Hola ${displayName},`,
    '',
    'Tu perfil fue verificado. Ya tenés la insignia Fitnexia en tu perfil público.',
    '',
    '— Fitnexia',
  ].join('\n');
  const html = `
    <p>Hola ${escapeHtml(displayName)},</p>
    <p>Tu perfil fue <strong>verificado</strong>. Ya tenés la insignia Fitnexia en tu perfil público.</p>
    <p>— Fitnexia</p>
  `;
  return sendMail({ to, subject, text, html });
}

async function sendVerificationRejectedEmail({ to, displayName, reason }) {
  const subject = 'Actualización sobre tu verificación — Fitnexia';
  const preview = reason.length > 200 ? `${reason.slice(0, 197)}…` : reason;
  const text = [
    `Hola ${displayName},`,
    '',
    'No pudimos aprobar tu solicitud de verificación en este momento.',
    `Motivo: ${preview}`,
    '',
    'Podés enviar una nueva solicitud desde la app.',
    '',
    '— Fitnexia',
  ].join('\n');
  const html = `
    <p>Hola ${escapeHtml(displayName)},</p>
    <p>No pudimos aprobar tu solicitud de verificación en este momento.</p>
    <p><strong>Motivo:</strong> ${escapeHtml(preview)}</p>
    <p>Podés enviar una nueva solicitud desde la app.</p>
    <p>— Fitnexia</p>
  `;
  return sendMail({ to, subject, text, html });
}

async function sendVerificationPendingReminderEmail({ to, displayName }) {
  const subject = 'Tu verificación sigue en revisión — Fitnexia';
  const text = [
    `Hola ${displayName},`,
    '',
    'Tu solicitud de verificación sigue en revisión. Te avisaremos cuando haya novedades.',
    '',
    '— Fitnexia',
  ].join('\n');
  const html = `
    <p>Hola ${escapeHtml(displayName)},</p>
    <p>Tu solicitud de verificación sigue en revisión. Te avisaremos cuando haya novedades.</p>
    <p>— Fitnexia</p>
  `;
  return sendMail({ to, subject, text, html });
}

module.exports = {
  sendMail,
  sendInstructorInviteEmail,
  sendPaymentReceiptEmails,
  sendPasswordResetEmail,
  sendMembershipInviteEmail,
  sendMembershipDueReminderEmail,
  sendMembershipOverdueEmail,
  sendMembershipPaymentReceiptEmail,
  sendMembershipArrearsAlertEmail,
  sendVerificationReceivedEmail,
  sendVerificationApprovedEmail,
  sendVerificationRejectedEmail,
  sendVerificationPendingReminderEmail,
  renderPasswordResetOpenPage,
  buildPasswordResetAppLinks,
  isEmailEnabled: () => emailEnabled,
};
