// Default for tests: Play has nothing newer, or the module is absent.
module.exports = {
  availableVersionCode: jest.fn(() => Promise.resolve(null)),
};
