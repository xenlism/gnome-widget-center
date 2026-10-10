// hashes.js - the two hash functions the pure modules take as arguments, backed by GLib (GJS only).
import GLib from "gi://GLib";
import { hexToBytes } from "./signature.js";

export const sha256 = u8 => GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, new GLib.Bytes(u8));
export const sha512 = u8 => hexToBytes(GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA512, new GLib.Bytes(u8)));
