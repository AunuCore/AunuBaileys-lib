import os, re, json, shutil

import sys
# Pakai: python3 scripts/assemble-fork.py <folder-baileys-baru> <folder-baileys-6.6>
# Ekstrak dulu:  npm pack @whiskeysockets/baileys@6.7.24 && tar xzf *.tgz
SRC = sys.argv[1]
OLD = sys.argv[2]
DST = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + '-assembled'

if os.path.exists(DST): shutil.rmtree(DST)
shutil.copytree(SRC, DST)
os.makedirs(f'{DST}/lib/Store', exist_ok=True)

# ---------- konversi make-ordered-dictionary.js ----------
c = open(f'{OLD}/lib/Store/make-ordered-dictionary.js', encoding='utf-8').read()
c = c.replace('"use strict";\n', '').replace('Object.defineProperty(exports, "__esModule", { value: true });\n', '')
c = c.replace('exports.default = makeOrderedDictionary;', 'export default makeOrderedDictionary;')
open(f'{DST}/lib/Store/make-ordered-dictionary.js', 'w', encoding='utf-8').write(c)

# ---------- konversi object-repository.js ----------
c = open(f'{OLD}/lib/Store/object-repository.js', encoding='utf-8').read()
c = c.replace('"use strict";\n', '').replace('Object.defineProperty(exports, "__esModule", { value: true });\n', '')
c = c.replace('exports.ObjectRepository = void 0;\n', '').replace('exports.ObjectRepository = ObjectRepository;', 'export { ObjectRepository };')
open(f'{DST}/lib/Store/object-repository.js', 'w', encoding='utf-8').write(c)

# ---------- konversi make-in-memory-store.js ----------
lines = open(f'{OLD}/lib/Store/make-in-memory-store.js', encoding='utf-8').read().split('\n')
# buang header CJS (sampai baris require terakhir, idx 12 = line 13)
body = '\n'.join(lines[13:])
body = body.replace('exports.waChatKey = waChatKey;', '')
body = body.replace('exports.waMessageID = waMessageID;', '')
body = body.replace('exports.waLabelAssociationKey = {', 'const waLabelAssociationKey = {')
body = body.replace('exports.default = ({ logger: _logger, chatKey, labelAssociationKey }) => {',
                    'const makeInMemoryStore = ({ logger: _logger, chatKey, labelAssociationKey }) => {')
body = body.replace("const KeyedDB = require('@adiwajshing/keyed-db').default;", '')
body = body.replace("const { writeFileSync } = require('fs');", '')
body = body.replace("const { readFileSync, existsSync } = require('fs');", '')
for a, b in [('WAProto_1.proto', 'proto'), ('Defaults_1.DEFAULT_CONNECTION_CONFIG', 'DEFAULT_CONNECTION_CONFIG'),
             ('LabelAssociation_1.LabelAssociationType', 'LabelAssociationType'),
             ('Utils_1.toNumber', 'toNumber'), ('Utils_1.updateMessageWithReaction', 'updateMessageWithReaction'),
             ('Utils_1.updateMessageWithReceipt', 'updateMessageWithReceipt'),
             ('WABinary_1.jidNormalizedUser', 'jidNormalizedUser'),
             ('make_ordered_dictionary_1.default', 'makeOrderedDictionary'),
             ('object_repository_1.ObjectRepository', 'ObjectRepository')]:
    body = body.replace(a, b)
header = """// AunuCore fork backport: in-memory store dari Baileys 6.6.0, dikonversi ke ESM untuk basis 6.7.x
import KeyedDB from '@adiwajshing/keyed-db';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { proto } from '../../WAProto/index.js';
import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { LabelAssociationType } from '../Types/LabelAssociation.js';
import { toNumber, updateMessageWithReaction, updateMessageWithReceipt } from '../Utils/index.js';
import { jidNormalizedUser } from '../WABinary/index.js';
import makeOrderedDictionary from './make-ordered-dictionary.js';
import { ObjectRepository } from './object-repository.js';
"""
body = header + body + '\nexport { waChatKey, waMessageID, waLabelAssociationKey };\nexport default makeInMemoryStore;\n'
open(f'{DST}/lib/Store/make-in-memory-store.js', 'w', encoding='utf-8').write(body)

# ---------- Store/index.js + d.ts ----------
open(f'{DST}/lib/Store/index.js', 'w', encoding='utf-8').write(
"""export { default as makeInMemoryStore } from './make-in-memory-store.js';
export { waChatKey, waMessageID, waLabelAssociationKey } from './make-in-memory-store.js';
""")
for f in ['make-in-memory-store.d.ts', 'object-repository.d.ts', 'make-ordered-dictionary.d.ts']:
    d = open(f'{OLD}/lib/Store/{f}', encoding='utf-8').read()
    d = d.replace("'../../WAProto'", "'../../WAProto/index.js'").replace("'../Socket'", "'../Socket/index.js'")
    d = d.replace("'../Types'", "'../Types/index.js'").replace("'../Types/Label'", "'../Types/Label.js'")
    d = d.replace("'../Types/LabelAssociation'", "'../Types/LabelAssociation.js'").replace("'./object-repository'", "'./object-repository.js'")
    d = d.replace("'./make-ordered-dictionary'", "'./make-ordered-dictionary.js'")
    open(f'{DST}/lib/Store/{f}', 'w', encoding='utf-8').write(d)
open(f'{DST}/lib/Store/index.d.ts', 'w', encoding='utf-8').write(
"""import makeInMemoryStore from './make-in-memory-store.js';
export { makeInMemoryStore };
export { waChatKey, waMessageID, waLabelAssociationKey } from './make-in-memory-store.js';
""")
# d.ts untuk dua file kecil: sesuaikan ekstensi import bila ada
for f in ['object-repository.js', 'make-ordered-dictionary.js']:
    src = f'{DST}/lib/Store/{f}'
    assert 'require(' not in open(src, encoding='utf-8').read(), f

# ---------- fork-compat: processedMessages + initInMemoryKeyStore ----------
open(f'{DST}/lib/Utils/fork-compat.js', 'w', encoding='utf-8').write(
"""// AunuCore fork compat — ekspor yang dulu disediakan fork Baileys populer (lilys/canta)
// dan diandalkan banyak script bot. Implementasi bersih, ditulis dari kontrak resmi Baileys.

/**
 * Registry pesan yang sudah diproses (dedup antar handler).
 * Script lama mengharapkan ekspor ini ada; isinya Map id-pesan -> true.
 */
export const processedMessages = new Map();

/**
 * Signal key store murni in-memory, kompatibel dengan kontrak SignalKeyStore
 * resmi (get/set/clear) — pasangan makeCacheableSignalKeyStore untuk sesi
 * yang tidak perlu persisten di disk.
 */
export const initInMemoryKeyStore = () => {
    const data = new Map();
    const k = (type, id) => `${type}:${id}`;
    return {
        get: async (type, ids) => {
            const out = {};
            for (const id of ids) {
                const key = k(type, id);
                if (data.has(key)) out[id] = data.get(key);
            }
            return out;
        },
        set: async (dataset) => {
            for (const type in dataset) {
                for (const id in dataset[type]) {
                    const v = dataset[type][id];
                    if (v) data.set(k(type, id), v);
                    else data.delete(k(type, id));
                }
            }
        },
        clear: async () => { data.clear(); }
    };
};
""")
open(f'{DST}/lib/Utils/fork-compat.d.ts', 'w', encoding='utf-8').write(
"""import type { SignalKeyStore } from '../Types/index.js';
export declare const processedMessages: Map<string, unknown>;
export declare const initInMemoryKeyStore: () => SignalKeyStore;
""")

# ---------- lib/index.js: tambahkan ekspor fork ----------
idx = open(f'{DST}/lib/index.js', encoding='utf-8').read()
idx += "export * from './Store/index.js';\nexport { processedMessages, initInMemoryKeyStore } from './Utils/fork-compat.js';\n"
open(f'{DST}/lib/index.js', 'w', encoding='utf-8').write(idx)
idts = open(f'{DST}/lib/index.d.ts', encoding='utf-8').read()
idts += "export * from './Store/index.js';\nexport { processedMessages, initInMemoryKeyStore } from './Utils/fork-compat.js';\n"
open(f'{DST}/lib/index.d.ts', 'w', encoding='utf-8').write(idts)

# ---------- package.json ----------
pj = json.load(open(f'{DST}/package.json', encoding='utf-8'))
pj['name'] = 'aunucore-baileys'
pj['version'] = '6.7.24-aunu.1'
pj['description'] = 'AunuCore fork of @whiskeysockets/baileys (6.7.24) — stability backports: makeInMemoryStore restored, fork-compat exports (processedMessages, initInMemoryKeyStore). Clean-room patches, MIT.'
pj['repository'] = {'type': 'git', 'url': 'git+https://github.com/AunuHost/aunucore-baileys.git'}
pj['homepage'] = 'https://github.com/AunuHost/aunucore-baileys#readme'
pj['bugs'] = {'url': 'https://github.com/AunuHost/aunucore-baileys/issues'}
deps = pj.get('dependencies', {})
deps['@adiwajshing/keyed-db'] = '^0.2.4'
pj['dependencies'] = deps
json.dump(pj, open(f'{DST}/package.json', 'w', encoding='utf-8'), indent=2)
print('FORK TERSUSUN di', DST)

# ---------- perbaikan pasca-konversi ----------
import subprocess
s = open(f'{DST}/lib/Store/make-in-memory-store.js', encoding='utf-8').read()
s = re.sub(r"\(0, exports\.(waChatKey|waMessageID|waLabelAssociationKey)\)", r"\1", s)
s = re.sub(r"exports\.(waChatKey|waMessageID|waLabelAssociationKey)\b", r"\1", s)
s = s.replace("import KeyedDB from '@adiwajshing/keyed-db';",
              "import KeyedDBModule from '@adiwajshing/keyed-db';\nconst KeyedDB = KeyedDBModule.default || KeyedDBModule;")
open(f'{DST}/lib/Store/make-in-memory-store.js', 'w', encoding='utf-8').write(s)
for pth in ['lib/index.js', 'lib/index.d.ts']:
    t = open(f'{DST}/{pth}', encoding='utf-8').read()
    t = t.replace('index.js.mapexport *', 'index.js.map\nexport *').replace('index.d.ts.mapexport *', 'index.d.ts.map\nexport *')
    t += "export { PHONENUMBER_MCC } from './Utils/phonenumber-mcc.js';\n" if pth.endswith('.js') else ""
    open(f'{DST}/{pth}', 'w', encoding='utf-8').write(t)
mcc = json.load(open(f'{OLD}/lib/Defaults/phonenumber-mcc.json', encoding='utf-8'))
open(f'{DST}/lib/Utils/phonenumber-mcc.js', 'w', encoding='utf-8').write(
    '// Tabel MCC dari Baileys 6.6 (dihapus di 6.7) — ekspor compat AunuBaileys\nexport const PHONENUMBER_MCC = ' + json.dumps(mcc) + ';\n')
open(f'{DST}/lib/Utils/phonenumber-mcc.d.ts', 'w', encoding='utf-8').write("export declare const PHONENUMBER_MCC: { [key: string]: string };\n")
_pj = json.load(open(f'{DST}/package.json', encoding='utf-8'))
_pj['scripts'] = {'preinstall': 'node ./engine-requirements.js'}
json.dump(_pj, open(f'{DST}/package.json', 'w', encoding='utf-8'), indent=2)
print('perbaikan pasca-konversi diterapkan (exports, KeyedDB, MCC, scripts)')
