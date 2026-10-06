module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  moduleNameMapper: {
    '^@du/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
    '^@du/connector$': '<rootDir>/../../services/connector/src/index.ts',
  },
  moduleFileExtensions: ['ts', 'js'],
};
