const nxPreset = require('@nx/jest/preset').default;

module.exports = {
  ...nxPreset,
  // Resolve workspace libs (@shop/domain) to their TypeScript sources, as the
  // "@org/source" custom condition in tsconfig.base.json does for tsc.
  testEnvironmentOptions: {
    customExportConditions: ['@org/source', 'node', 'require', 'default'],
  },
  // NodeNext-style "./x.js" imports point at "./x.ts" sources.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
