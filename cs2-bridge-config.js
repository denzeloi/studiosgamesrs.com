/**
 * CS2 integration — Firebase Cloud Functions (production)
 */
(function (global) {
  global.CS2_BRIDGE = {
    mode: 'firebase-functions',
    region: 'us-central1',
    projectId: 'studiosgamesrs',
    apiFunction: 'cs2NexusApi',
    webhookUrl: 'https://us-central1-studiosgamesrs.cloudfunctions.net/cs2MatchWebhook',
    provisionMode: 'snapshot',
    enabled: true,
  };
})(typeof window !== 'undefined' ? window : global);
