import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { StorageGateway } from "./ingestions.js";
import { sniffMime } from "./ingestions.js";

export const ORIGINAL_BUCKET = "sigongnote-originals";

export function createStorageGateway(url: string, secretKey: string): StorageGateway {
  const client = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const bucket = client.storage.from(ORIGINAL_BUCKET);
  return {
    async readBytes(path,maxBytes){
      const {data,error}=await bucket.createSignedUrl(path,60);if(error||!data)throw new Error('Original unavailable');
      const response=await fetch(new URL(data.signedUrl,url),{signal:AbortSignal.timeout(30000),redirect:'error'});
      if(!response.ok||!response.body)throw new Error('Original unavailable');
      const chunks:Uint8Array[]=[];let length=0;
      for await(const chunk of response.body){length+=chunk.length;if(length>maxBytes)throw new Error('Original too large');chunks.push(chunk);}
      return Buffer.concat(chunks);
    },
    async readUrl(path){const {data,error}=await bucket.createSignedUrl(path,60);if(error||!data)throw new Error("Original unavailable");return new URL(data.signedUrl,url).href;},
    async sign(path) {
      const { data, error } = await bucket.createSignedUploadUrl(path);
      if (error || !data) throw new Error("Storage signing unavailable");
      return data.signedUrl;
    },
    async verify(path, expectedSha256, expectedLength) {
      const { data, error } = await bucket.createSignedUrl(path, 60);
      if (error || !data) return null;
      const response = await fetch(new URL(data.signedUrl, url),
        { signal: AbortSignal.timeout(120_000), redirect:'error' });
      if (!response.ok || !response.body) return null;
      const digest = createHash("sha256");
      let length = 0;
      const prefix = new Uint8Array(65_536);
      let prefixLength = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 209715200) {
          return { matches:false, sniffedMime:"application/octet-stream" };
        }
        digest.update(chunk);
        const count = Math.min(chunk.length, prefix.length - prefixLength);
        if (count > 0) {
          prefix.set(chunk.subarray(0, count), prefixLength);
          prefixLength += count;
        }
      }
      return { matches:length === expectedLength && digest.digest("hex") === expectedSha256,
        sniffedMime:sniffMime(prefix.subarray(0,prefixLength)) };
    },
    async remove(path) {
      const { error } = await bucket.remove([path]);
      if (error) throw new Error("Storage cleanup unavailable");
    },
  };
}
