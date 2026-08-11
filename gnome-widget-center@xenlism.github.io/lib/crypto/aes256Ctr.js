const NB = 4;

const NK = 8;

const NR = 14;

const S_BOX = new Uint8Array([ 99, 124, 119, 123, 242, 107, 111, 197, 48, 1, 103, 43, 254, 215, 171, 118, 202, 130, 201, 125, 250, 89, 71, 240, 173, 212, 162, 175, 156, 164, 114, 192, 183, 253, 147, 38, 54, 63, 247, 204, 52, 165, 229, 241, 113, 216, 49, 21, 4, 199, 35, 195, 24, 150, 5, 154, 7, 18, 128, 226, 235, 39, 178, 117, 9, 131, 44, 26, 27, 110, 90, 160, 82, 59, 214, 179, 41, 227, 47, 132, 83, 209, 0, 237, 32, 252, 177, 91, 106, 203, 190, 57, 74, 76, 88, 207, 208, 239, 170, 251, 67, 77, 51, 133, 69, 249, 2, 127, 80, 60, 159, 168, 81, 163, 64, 143, 146, 157, 56, 245, 188, 182, 218, 33, 16, 255, 243, 210, 205, 12, 19, 236, 95, 151, 68, 23, 196, 167, 126, 61, 100, 93, 25, 115, 96, 129, 79, 220, 34, 42, 144, 136, 70, 238, 184, 20, 222, 94, 11, 219, 224, 50, 58, 10, 73, 6, 36, 92, 194, 211, 172, 98, 145, 149, 228, 121, 231, 200, 55, 109, 141, 213, 78, 169, 108, 86, 244, 234, 101, 122, 174, 8, 186, 120, 37, 46, 28, 166, 180, 198, 232, 221, 116, 31, 75, 189, 139, 138, 112, 62, 181, 102, 72, 3, 246, 14, 97, 53, 87, 185, 134, 193, 29, 158, 225, 248, 152, 17, 105, 217, 142, 148, 155, 30, 135, 233, 206, 85, 40, 223, 140, 161, 137, 13, 191, 230, 66, 104, 65, 153, 45, 15, 176, 84, 187, 22 ]);

const RCON = new Uint8Array([ 1, 2, 4, 8, 16, 32, 64, 128, 27, 54, 108, 216, 171, 77 ]);

function xtime(a) {
    return (a << 1 ^ (a & 128 ? 27 : 0)) & 255;
}

function gmul(a, b) {
    let p = 0;
    for (let i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        const hiBitSet = a & 128;
        a = a << 1 & 255;
        if (hiBitSet) a ^= 27;
        b >>= 1;
    }
    return p & 255;
}

function expandKey(key) {
    if (key.length !== 32) throw new Error(`aes256Ctr: key must be 32 bytes, got ${key.length}`);
    const totalWords = NB * (NR + 1);
    const w = new Uint8Array(totalWords * 4);
    w.set(key.subarray(0, 32));
    const temp = new Uint8Array(4);
    for (let i = NK; i < totalWords; i++) {
        temp.set(w.subarray((i - 1) * 4, i * 4));
        if (i % NK === 0) {
            const t0 = temp[0];
            temp[0] = S_BOX[temp[1]] ^ RCON[i / NK - 1];
            temp[1] = S_BOX[temp[2]];
            temp[2] = S_BOX[temp[3]];
            temp[3] = S_BOX[t0];
        } else if (i % NK === 4) {
            for (let j = 0; j < 4; j++) temp[j] = S_BOX[temp[j]];
        }
        for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - NK) * 4 + j] ^ temp[j];
    }
    return w;
}

function addRoundKey(state, schedule, round) {
    const offset = round * 16;
    for (let i = 0; i < 16; i++) state[i] ^= schedule[offset + i];
}

function subBytes(state) {
    for (let i = 0; i < 16; i++) state[i] = S_BOX[state[i]];
}

function shiftRows(state) {
    const s = state.slice();
    for (let row = 1; row < 4; row++) {
        for (let col = 0; col < 4; col++) state[col * 4 + row] = s[(col + row) % 4 * 4 + row];
    }
}

function mixColumns(state) {
    for (let col = 0; col < 4; col++) {
        const a0 = state[col * 4 + 0], a1 = state[col * 4 + 1], a2 = state[col * 4 + 2], a3 = state[col * 4 + 3];
        state[col * 4 + 0] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
        state[col * 4 + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
        state[col * 4 + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
        state[col * 4 + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
    }
}

function encryptBlock(block, schedule) {
    addRoundKey(block, schedule, 0);
    for (let round = 1; round < NR; round++) {
        subBytes(block);
        shiftRows(block);
        mixColumns(block);
        addRoundKey(block, schedule, round);
    }
    subBytes(block);
    shiftRows(block);
    addRoundKey(block, schedule, NR);
}

function incrementCounter(counter) {
    for (let i = 15; i >= 0; i--) {
        counter[i] = counter[i] + 1 & 255;
        if (counter[i] !== 0) break;
    }
}

export function aes256CtrTransform(data, key, iv) {
    if (iv.length !== 16) throw new Error(`aes256Ctr: iv must be 16 bytes, got ${iv.length}`);
    const schedule = expandKey(key);
    const counter = iv.slice();
    const out = new Uint8Array(data.length);
    for (let offset = 0; offset < data.length; offset += 16) {
        const keystreamBlock = counter.slice();
        encryptBlock(keystreamBlock, schedule);
        const chunkLen = Math.min(16, data.length - offset);
        for (let i = 0; i < chunkLen; i++) out[offset + i] = data[offset + i] ^ keystreamBlock[i];
        incrementCounter(counter);
    }
    return out;
}