// a bunch of helpers to work with binary data in JS

/**
 * Convert a buffer into a string of 1-byte encoded characters
 * @param buffer {Buffer}
 * @return {string}
 */
function bufferToString(buffer) {
  let str = '';
  for (let i = 0; i < buffer.length; i++) {
    const number = buffer.readUint8(i);
    str += String.fromCodePoint(number);
  }
  return str;
}

/**
 * Same as {@link bufferToString}, but convert to BASE64
 * @param buffer {Buffer}
 * @return {string}
 */
function bufferToBase64(buffer) {
  return btoa(bufferToString(buffer));
}

/**
 * Convert a string of 1-byte encoded character into a buffer
 * @param str {string}
 * @return {Buffer}
 */
function stringToBuffer(str) {
  return Buffer.from(Array.from(str).map((c) => c.codePointAt(0)));
}

/**
 * Same as {@link stringToBuffer}, but initial string is BASE64-encoded.
 * @param str {string}
 * @return {Buffer}
 */
function base64ToBuffer(str) {
  return stringToBuffer(atob(str));
}

module.exports = {
  bufferToString,
  bufferToBase64,
  stringToBuffer,
  base64ToBuffer,
};
