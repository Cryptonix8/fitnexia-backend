const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const classesService = require('../services/classes.service');

const router = Router();

router.get(
  '/home',
  asyncHandler(async (req, res) => {
    const feed = await classesService.homeFeed();
    res.json(feed);
  }),
);

module.exports = router;
