import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvRecords } from '../src/csv.js';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, commas and newlines inside quotes', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"multi\nline",z')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', 'z'],
    ]);
  });

  it('handles CRLF, a BOM, trailing newline and blank lines', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n\r\n3,4\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('keeps empty cells', () => {
    expect(parseCsv('a,,c\n,,')).toEqual([['a', '', 'c']]);
  });

  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('a,"b\n')).toThrow(/unterminated/);
  });
});

describe('parseCsvRecords', () => {
  it('normalises headers and fills missing cells', () => {
    expect(parseCsvRecords('SKU, Generic Name\nP1').records).toEqual([{ sku: 'P1', generic_name: '' }]);
  });
});
