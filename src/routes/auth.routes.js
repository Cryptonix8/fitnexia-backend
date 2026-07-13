const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const authService = require('../services/auth.service');
const { renderPasswordResetOpenPage } = require('../services/email.service');
const {
  apiPublicUrl,
  appDeepLinkScheme,
  androidAppPackage,
  passwordResetExpiresMinutes,
} = require('../config/env');

const router = Router();

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const result = await authService.register(req.body);
    res.status(201).json(result);
  }),
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const result = await authService.login(req.body.email, req.body.password);
    res.json(result);
  }),
);

router.post(
  '/oauth/google',
  asyncHandler(async (req, res) => {
    const result = await authService.googleOAuth(req.body);
    const { isNewUser, ...tokens } = result;
    res.status(isNewUser ? 201 : 200).json(tokens);
  }),
);

router.post(
  '/oauth/apple',
  asyncHandler(async (req, res) => {
    const result = await authService.appleOAuth(req.body);
    const { isNewUser, ...tokens } = result;
    res.status(isNewUser ? 201 : 200).json(tokens);
  }),
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const result = await authService.refresh(req.body.refreshToken);
    res.json(result);
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await authService.logout(req.body.refreshToken);
    res.status(204).send();
  }),
);

router.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await authService.changePassword(req.user.id, req.body);
    res.json(result);
  }),
);

router.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    await authService.forgotPassword(req.body.email);
    res.status(204).send();
  }),
);

router.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    await authService.resetPassword(req.body.token, req.body.password);
    res.status(204).send();
  }),
);

router.get(
  '/reset-password/open',
  asyncHandler(async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
    if (!token) {
      res.status(400).type('html').send('<p>Enlace inválido.</p>');
      return;
    }
    const query = `token=${encodeURIComponent(token)}`;
    const appResetUrl = `${appDeepLinkScheme}:///reset-password?${query}`;
    const androidIntentUrl = `intent://reset-password?${query}#Intent;scheme=${appDeepLinkScheme};package=${androidAppPackage};end`;
    res
      .type('html')
      .send(
        renderPasswordResetOpenPage({
          token,
          apiPublicUrl,
          appResetUrl,
          androidIntentUrl,
          expiresMinutes: passwordResetExpiresMinutes,
        }),
      );
  }),
);

module.exports = router;
