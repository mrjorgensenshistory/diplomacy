/* ============================================================
 * DIPLOMACY — client configuration
 *
 * API_URL:
 *   'MOCK'  -> practice mode: everything runs in this browser
 *              only (localStorage). Great for testing and demos.
 *   'https://script.google.com/macros/s/XXXX/exec'
 *           -> your deployed Google Apps Script web app. This is
 *              the real classroom mode. See README for setup.
 * ============================================================ */

var DIPLO_CONFIG = {
  API_URL: 'MOCK',
  POLL_SECONDS: 10
};
