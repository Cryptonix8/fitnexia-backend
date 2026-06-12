const {
  mercadopagoAccessToken,
  mercadopagoAppId,
  mercadopagoClientSecret,
  mercadopagoMarketplaceEnabled,
  marketplaceGymPayee,
  marketplacePassRevenue,
  marketplaceRequireSellerConnect,
} = require('./env');

const VALID_GYM_PAYEES = ['institution', 'instructor', 'split'];
const VALID_PASS_REVENUE = ['platform_ledger', 'split_at_purchase'];

function getGymPayeePolicy() {
  const value = (marketplaceGymPayee || 'institution').toLowerCase();
  return VALID_GYM_PAYEES.includes(value) ? value : 'institution';
}

function getPassRevenuePolicy() {
  const value = (marketplacePassRevenue || 'platform_ledger').toLowerCase();
  return VALID_PASS_REVENUE.includes(value) ? value : 'platform_ledger';
}

function isMarketplaceConfigured() {
  return Boolean(
    mercadopagoAppId &&
      mercadopagoClientSecret &&
      (mercadopagoAccessToken || process.env.MERCADOPAGO_PLATFORM_ACCESS_TOKEN),
  );
}

function isMarketplaceEnabled() {
  return mercadopagoMarketplaceEnabled && isMarketplaceConfigured();
}

function requireSellerConnect() {
  return marketplaceRequireSellerConnect;
}

function getMarketplacePublicConfig() {
  return {
    enabled: isMarketplaceEnabled(),
    configured: isMarketplaceConfigured(),
    requireSellerConnect: requireSellerConnect(),
    gymPayeePolicy: getGymPayeePolicy(),
    passRevenuePolicy: getPassRevenuePolicy(),
  };
}

module.exports = {
  getGymPayeePolicy,
  getPassRevenuePolicy,
  isMarketplaceConfigured,
  isMarketplaceEnabled,
  requireSellerConnect,
  getMarketplacePublicConfig,
};
