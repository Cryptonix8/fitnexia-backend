const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const { isDev } = require('../config/env');
const {
  buildPlatformBillingDeepLink,
} = require('../services/mercadopago.service');
const platformBillingService = require('../services/platform-billing.service');
const gymSubscriptionService = require('../services/gym-subscription.service');

const router = Router();

router.post(
  '/gym/subscribe',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const result = await platformBillingService.startGymTierBilling(req.user.id, req.body.tier);
    res.json(result);
  }),
);

router.post(
  '/instructor/subscribe',
  requireAuth,
  requireRole('instructor'),
  asyncHandler(async (req, res) => {
    const result = await platformBillingService.startInstructorPlanBilling(
      req.user.id,
      req.body.plan,
    );
    res.json(result);
  }),
);

router.get(
  '/return',
  asyncHandler(async (req, res) => {
    const kind = String(req.query.kind || 'gym');
    const ownerId = String(req.query.ownerId || '');
    const status = String(req.query.status || 'success');
    res.redirect(buildPlatformBillingDeepLink(kind, ownerId, status));
  }),
);

if (isDev) {
  router.get(
    '/mock-checkout/gym/:institutionId',
    asyncHandler(async (req, res) => {
      const tier = String(req.query.tier || 'professional');
      await platformBillingService.activateGymBilling(req.params.institutionId, { tierId: tier });
      res.send(
        `<html><body style="font-family:sans-serif;padding:2rem"><h1>Mock gym billing OK</h1><p>Tier: ${tier}</p><p><a href="${buildPlatformBillingDeepLink('gym', req.params.institutionId, 'success')}">Volver a Fitnexia</a></p></body></html>`,
      );
    }),
  );

  router.get(
    '/mock-checkout/instructor/:instructorId',
    asyncHandler(async (req, res) => {
      const plan = String(req.query.plan || 'pro');
      await platformBillingService.activateInstructorBilling(req.params.instructorId, {
        planId: plan,
      });
      res.send(
        `<html><body style="font-family:sans-serif;padding:2rem"><h1>Mock instructor billing OK</h1><p>Plan: ${plan}</p><p><a href="${buildPlatformBillingDeepLink('instructor', req.params.instructorId, 'success')}">Volver a Fitnexia</a></p></body></html>`,
      );
    }),
  );
}

router.get(
  '/gym/me',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const subscription = await gymSubscriptionService.getSubscriptionForUser(req.user.id);
    res.json(subscription);
  }),
);

module.exports = router;
