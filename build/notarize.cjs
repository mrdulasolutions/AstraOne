/**
 * afterSign hook for electron-builder.
 *
 * Only runs in CI / release pipelines when all three env vars are set:
 *   APPLE_ID                 — your Apple ID
 *   APPLE_APP_SPECIFIC_PASSWORD — app-specific password (NOT your Apple ID password)
 *   APPLE_TEAM_ID            — your 10-char team identifier
 *
 * Without those vars, this is a no-op so local `npm run dist` produces an
 * unsigned/un-notarized .dmg that still works for testing.
 *
 * Once you have a Developer ID Application certificate in your Keychain AND
 * the three env vars set, electron-builder will sign + this hook notarizes.
 */

const { notarize } = require('@electron/notarize');

exports.default = async function afterSign(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] skipping (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set)');
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  console.log(`[notarize] submitting ${appPath} …`);

  await notarize({
    tool: 'notarytool',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log('[notarize] complete');
};
