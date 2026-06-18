const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const { isDev } = require('../config/env');
const {
  buildMembershipDeepLink,
  fetchMercadoPagoPreapproval,
  isMercadoPagoConfigured,
} = require('../services/mercadopago.service');
const membershipsService = require('../services/memberships.service');
const { pool } = require('../db/pool');

const router = Router();

router.get(
  '/authorize-return',
  asyncHandler(async (req, res) => {
    const memberId = String(req.query.memberId || '');
    const preapprovalId = req.query.preapproval_id
      ? String(req.query.preapproval_id)
      : req.query.preapprovalId
        ? String(req.query.preapprovalId)
        : null;

    let status = req.query.status === 'failure' ? 'failure' : 'success';

    if (memberId && preapprovalId && isMercadoPagoConfigured()) {
      try {
        const preapproval = await fetchMercadoPagoPreapproval(preapprovalId);
        if (preapproval.status === 'authorized') {
          const subscriptionId = String(preapproval.external_reference || '').startsWith('msub:')
            ? String(preapproval.external_reference).slice('msub:'.length)
            : null;
          if (subscriptionId) {
            await membershipsService.handlePreapprovalAuthorized(subscriptionId, preapprovalId);
          }
          status = 'success';
        } else if (['cancelled', 'paused'].includes(preapproval.status)) {
          status = 'failure';
        }
      } catch {
        // Webhook may still activate; continue to app redirect.
      }
    } else if (memberId && preapprovalId) {
      const { rows } = await pool.query(
        `SELECT ms.id FROM membership_subscriptions ms
         JOIN club_members cm ON cm.id = ms.club_member_id
         WHERE cm.id = $1`,
        [memberId],
      );
      if (rows.length) {
        await membershipsService
          .handlePreapprovalAuthorized(rows[0].id, preapprovalId)
          .catch(() => {});
      }
    }

    if (!memberId) {
      res.status(400).send('Missing memberId');
      return;
    }

    const deepLink = buildMembershipDeepLink(memberId, status);
    res.redirect(deepLink);
  }),
);

router.get(
  '/invites/:code',
  asyncHandler(async (req, res) => {
    const invite = await membershipsService.getInviteByCode(req.params.code);
    res.json(invite);
  }),
);

router.post(
  '/invites/:code/accept',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const result = await membershipsService.acceptInvite(req.user, req.params.code);
    res.status(201).json(result);
  }),
);

router.get(
  '/me',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const data = await membershipsService.getMyMemberships(req.user.id);
    res.json({ data });
  }),
);

router.get(
  '/me/:memberId/statement',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const statement = await membershipsService.getStatement(req.user.id, req.params.memberId);
    res.json(statement);
  }),
);

router.post(
  '/me/:memberId/authorize',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const result = await membershipsService.startAuthorization(req.user, req.params.memberId);
    res.json(result);
  }),
);

router.post(
  '/me/:memberId/pay-debt',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const result = await membershipsService.payDebt(req.user.id, req.params.memberId);
    res.json(result);
  }),
);

router.get(
  '/mock-authorize/:subscriptionId',
  asyncHandler(async (req, res) => {
    if (!isDev) {
      res.status(404).send('Not found');
      return;
    }

    const { rows } = await require('../db/pool').query(
      `SELECT ms.*, cm.id AS member_id FROM membership_subscriptions ms
       JOIN club_members cm ON cm.id = ms.club_member_id
       WHERE ms.id = $1`,
      [req.params.subscriptionId],
    );
    if (!rows.length) {
      res.status(404).send('Subscription not found');
      return;
    }

    const sub = rows[0];
    const approveUrl = `${req.protocol}://${req.get('host')}/v1/memberships/mock-authorize/${sub.id}/approve`;
    const deepLink = buildMembershipDeepLink(sub.member_id, 'success');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Fitnexia — Autorizar débito</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:24px;text-align:center}
  button{background:#2B59C3;color:#fff;border:none;padding:14px 28px;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;width:100%}
  p{color:#64748b;line-height:1.5}
</style></head>
<body>
  <h1>Autorizar débito automático</h1>
  <p>Simular autorización de Mercado Pago (solo desarrollo).</p>
  <form method="POST" action="${approveUrl}">
    <button type="submit">Autorizar y activar membresía</button>
  </form>
  <p style="margin-top:24px;font-size:13px"><a href="${deepLink}">Volver a la app</a></p>
</body></html>`);
  }),
);

router.post(
  '/mock-authorize/:subscriptionId/approve',
  asyncHandler(async (req, res) => {
    if (!isDev) {
      res.status(404).send('Not found');
      return;
    }

    const { rows } = await require('../db/pool').query(
      `SELECT ms.*, cm.id AS member_id FROM membership_subscriptions ms
       JOIN club_members cm ON cm.id = ms.club_member_id
       WHERE ms.id = $1`,
      [req.params.subscriptionId],
    );
    if (!rows.length) {
      res.status(404).send('Subscription not found');
      return;
    }

    await membershipsService.activateSubscription(req.params.subscriptionId, {
      preapprovalId: `mock-${req.params.subscriptionId}`,
    });

    const deepLink = buildMembershipDeepLink(rows[0].member_id, 'success');
    res.redirect(deepLink);
  }),
);

router.get(
  '/mock-checkout/:paymentId',
  asyncHandler(async (req, res) => {
    if (!isDev) {
      res.status(404).send('Not found');
      return;
    }

    const payment = await membershipsService.getMembershipPaymentById(req.params.paymentId);
    const amount = (payment.amount_cents / 100).toFixed(2);
    const approveUrl = `${req.protocol}://${req.get('host')}/v1/memberships/mock-checkout/${payment.id}/approve`;
    const deepLink = buildMembershipDeepLink(payment.club_member_id, 'success');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Fitnexia — Pago de cuota</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:24px;text-align:center}
  button{background:#2B59C3;color:#fff;border:none;padding:14px 28px;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;width:100%}
  p{color:#64748b;line-height:1.5}
</style></head>
<body>
  <h1>Pago de cuota pendiente</h1>
  <p>Simular Mercado Pago (solo desarrollo).</p>
  <p><strong>$${amount} ${payment.currency}</strong></p>
  <form method="POST" action="${approveUrl}">
    <button type="submit">Pagar y regularizar</button>
  </form>
  <p style="margin-top:24px;font-size:13px"><a href="${deepLink}">Volver a la app</a></p>
</body></html>`);
  }),
);

router.post(
  '/mock-checkout/:paymentId/approve',
  asyncHandler(async (req, res) => {
    if (!isDev) {
      res.status(404).send('Not found');
      return;
    }

    const payment = await membershipsService.getMembershipPaymentById(req.params.paymentId);
    await membershipsService.confirmMembershipPayment(payment.id, `mock-${payment.id}`);
    const deepLink = buildMembershipDeepLink(payment.club_member_id, 'success');
    res.redirect(deepLink);
  }),
);

module.exports = router;
