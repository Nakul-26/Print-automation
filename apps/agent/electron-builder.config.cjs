/**
 * Two packages from the same code (see docs/adr/0010-print-agent.md):
 *   pnpm pack:installer  -> release/*.exe   (Track B: manual installer, updates itself from our server)
 *   pnpm pack:store      -> release/*.appx  (Track A: Microsoft Store, updated by the Store)
 *
 * Store identity values come from Partner Center (Product identity). Until the account exists
 * the placeholders below are used, which is enough to build and test the package locally.
 */
const identity = {
  name: process.env.STORE_IDENTITY_NAME || 'PrintPlatform.PrintingApp',
  publisher: process.env.STORE_PUBLISHER || 'CN=00000000-0000-0000-0000-000000000000',
  publisherDisplayName: process.env.STORE_PUBLISHER_DISPLAY_NAME || 'Print Platform',
};

module.exports = {
  appId: 'com.printplatform.agent',
  productName: 'Print Platform Printing App',
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*', 'assets/**/*', 'package.json'],
  extraResources: [{ from: 'vendor/sumatra/SumatraPDF.exe', to: 'sumatra/SumatraPDF.exe' }],
  asar: true,
  win: {
    target: ['nsis'],
    icon: 'assets/icon.png',
    artifactName: 'PrintPlatform-PrintingApp-${version}-Setup.${ext}',
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
  },
  appx: {
    applicationId: 'PrintingApp',
    identityName: identity.name,
    publisher: identity.publisher,
    publisherDisplayName: identity.publisherDisplayName,
    displayName: 'Print Platform Printing App',
    backgroundColor: '#0b7a8f',
    languages: ['en-US'],
    artifactName: 'PrintPlatform-PrintingApp-${version}.${ext}',
  },
  // Manual-installer updates come from our own server (set UPDATE_URL when building).
  publish: process.env.UPDATE_URL ? [{ provider: 'generic', url: process.env.UPDATE_URL }] : [],
};
