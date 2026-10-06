"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.multipartUploadHandle = multipartUploadHandle;
const node_crypto_1 = require("node:crypto");
/** Narrows a provider upload id to the stable opaque handle on the wire. */
function multipartUploadHandle(uploadId) {
    return `mh_${(0, node_crypto_1.createHash)('sha256').update(uploadId).digest('hex').slice(0, 16)}`;
}
