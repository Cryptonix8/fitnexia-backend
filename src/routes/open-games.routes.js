const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const openGamesService = require('../services/open-games.service');

const router = Router();

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = await openGamesService.listGames(req.user, req.query);
    res.json({ data });
  }),
);

router.get(
  '/me',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const data = await openGamesService.listMyGames(req.user);
    res.json({ data });
  }),
);

router.get(
  '/sports',
  (req, res) => {
    res.json({ data: openGamesService.OPEN_GAME_SPORTS });
  },
);

router.post(
  '/',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const game = await openGamesService.createGame(req.user, req.body);
    res.status(201).json(game);
  }),
);

router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await openGamesService.getGame(req.user, req.params.id);
    res.json(game);
  }),
);

router.post(
  '/:id/join',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const game = await openGamesService.joinGame(req.user, req.params.id);
    res.json(game);
  }),
);

router.post(
  '/:id/leave',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const game = await openGamesService.leaveGame(req.user, req.params.id);
    res.json(game);
  }),
);

router.post(
  '/:id/cancel',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const game = await openGamesService.cancelGame(req.user, req.params.id);
    res.json(game);
  }),
);

module.exports = router;
