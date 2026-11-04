// Default for tests: the native widget module is absent, as on iOS.
module.exports = {
  widgetsAvailable: false,
  hasSnapshotReaders: jest.fn(() => false),
  readSnapshot: jest.fn(() => null),
  writeSnapshot: jest.fn(() => Promise.resolve()),
  clearSnapshot: jest.fn(() => Promise.resolve()),
  getHideAmounts: jest.fn(() => false),
  setHideAmounts: jest.fn(() => Promise.resolve()),
  canPinWidgets: jest.fn(() => false),
  pinWidget: jest.fn(() => false),
};
