"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultParserFactory = exports.DocumentParserFactory = void 0;
const detector_1 = require("../formats/detector");
const text_parser_1 = require("./text-parser");
const word_parser_1 = require("./word-parser");
const excel_parser_1 = require("./excel-parser");
const pdf_parser_1 = require("./pdf-parser");
class DocumentParserFactory {
    parsers = [];
    constructor() {
        this.registerDefaults();
    }
    registerDefaults() {
        this.parsers.push(new text_parser_1.TextParser());
        this.parsers.push(new word_parser_1.WordParser());
        this.parsers.push(new excel_parser_1.ExcelParser());
        this.parsers.push(new pdf_parser_1.PdfParser());
    }
    registerParser(parser) {
        this.parsers.unshift(parser); // New parsers take precedence
    }
    getParser(formatInfo) {
        for (const parser of this.parsers) {
            if (parser.canHandle(formatInfo)) {
                return parser;
            }
        }
        return null;
    }
    async parseBuffer(buffer, fileName, mimeHint) {
        const formatInfo = detector_1.DocumentFormatDetector.detect(buffer, fileName, mimeHint);
        const parser = this.getParser(formatInfo);
        if (!parser) {
            throw new Error(`No suitable native parser found for format "${formatInfo.format}" (${formatInfo.mimeType})`);
        }
        return parser.parse(buffer, fileName);
    }
}
exports.DocumentParserFactory = DocumentParserFactory;
// Global default factory instance
exports.defaultParserFactory = new DocumentParserFactory();
//# sourceMappingURL=factory.js.map