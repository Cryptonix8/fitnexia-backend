const DISCIPLINES = require('../config/disciplines').DISCIPLINES;

const { getPlans: getPlansFromConfig } = require('../config/plans');
const { listTierCatalog } = require('./gym-subscription.service');

const { defaultCurrency, livekitConfigured } = require('../config/env');
const { isPaymentsActive } = require('./payments-active');
const { getMarketplacePublicConfig } = require('../config/marketplace.config');

function getDisciplines() {
  return DISCIPLINES;
}

function getPlans() {
  return getPlansFromConfig();
}

function getAppConfig() {
  return {
    minAppVersion: { ios: '1.0.0', android: '1.0.0' },
    features: {
      googleSignIn: true,
      appleSignIn: true,
      geolocationMap: true,
      integratedPayments: isPaymentsActive(),
      subscriptionPaymentModels: true,
      advancedSearch: true,
      waitlist: true,
      reviewResponses: true,
      inAppNotificationCenter: true,
      analyticsMetrics: true,
      clubMemberships: true,
      courts: true,
      marketplacePayouts: getMarketplacePublicConfig().enabled,
      loyaltyCredits: true,
      fixedCourtShifts: true,
      openGames: true,
      liveStreaming: livekitConfigured,
      recordedClasses: false,
      multipleCurrencies: false,
      digitalWallets: false,
      platformSupport: false,
    },
    currency: defaultCurrency,
  };
}

function getPaymentsConfig() {
  return {
    enabled: isPaymentsActive(),
    currency: defaultCurrency,
    provider: 'mercado_pago',
    marketplace: getMarketplacePublicConfig(),
  };
}

function getGymTiers() {
  return listTierCatalog();
}

module.exports = { getDisciplines, getPlans, getGymTiers, getAppConfig, getPaymentsConfig };
