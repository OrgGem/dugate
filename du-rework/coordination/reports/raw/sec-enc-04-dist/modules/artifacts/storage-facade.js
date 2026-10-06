"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArtifactStorageError = void 0;
/** Stable storage failures keep provider exception text out of API responses and logs. */
class ArtifactStorageError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'ArtifactStorageError';
    }
}
exports.ArtifactStorageError = ArtifactStorageError;
