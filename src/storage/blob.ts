// src/storage/blob.ts
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} from '@azure/storage-blob';

export interface BlobStorage {
  upload(blobName: string, data: Buffer, contentType: string): Promise<string>;
  exists(blobName: string): Promise<boolean>;
  getUrl(blobName: string): string;
  /**
   * Append a read-only SAS query string to a blob URL so it can be fetched
   * without account credentials. Default TTL: 60 minutes.
   *
   * Pass-through behavior: returns the input URL unchanged if it is empty,
   * not a same-account URL, or already contains a SAS token (`sig=...`).
   * That makes this safe to apply to arbitrary `blob_url` values pulled
   * from the database without first checking whether they belong to us.
   */
  getReadSasUrl(blobUrl: string, ttlMinutes?: number): string;
}

interface ConnStringParts {
  accountName: string;
  accountKey: string;
}

function parseConnectionString(connStr: string): ConnStringParts {
  const parts: Record<string, string> = {};
  for (const segment of connStr.split(';')) {
    const eq = segment.indexOf('=');
    if (eq > 0) {
      const key = segment.slice(0, eq);
      const value = segment.slice(eq + 1);
      parts[key] = value;
    }
  }
  if (!parts.AccountName || !parts.AccountKey) {
    throw new Error('Azure Storage connection string missing AccountName or AccountKey');
  }
  return { accountName: parts.AccountName, accountKey: parts.AccountKey };
}

export function createBlobStorage(connectionString: string, containerName: string): BlobStorage {
  const { accountName, accountKey } = parseConnectionString(connectionString);
  const sharedKey = new StorageSharedKeyCredential(accountName, accountKey);
  const serviceClient = BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = serviceClient.getContainerClient(containerName);

  // Pre-compute the prefix that all of our same-account blob URLs share so we
  // can recognize them when sign-ing arbitrary URLs from the DB.
  const accountHostPrefix = `https://${accountName}.blob.core.windows.net/${containerName}/`;

  return {
    async upload(blobName, data, contentType) {
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.upload(data, data.length, {
        blobHTTPHeaders: { blobContentType: contentType },
      });
      return blockBlobClient.url;
    },

    async exists(blobName) {
      try {
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.getProperties();
        return true;
      } catch (err: any) {
        if (err.statusCode === 404) return false;
        throw err;
      }
    },

    getUrl(blobName) {
      return containerClient.getBlockBlobClient(blobName).url;
    },

    getReadSasUrl(blobUrl, ttlMinutes = 60) {
      if (!blobUrl) return blobUrl;
      // Don't double-sign — if the URL already has a SAS token, pass through.
      if (blobUrl.includes('sig=')) return blobUrl;
      // Don't sign URLs we don't own (different storage account / container).
      if (!blobUrl.startsWith(accountHostPrefix)) return blobUrl;

      const blobName = blobUrl.slice(accountHostPrefix.length);
      const sas = generateBlobSASQueryParameters(
        {
          containerName,
          blobName,
          permissions: BlobSASPermissions.parse('r'),
          expiresOn: new Date(Date.now() + ttlMinutes * 60 * 1000),
        },
        sharedKey,
      ).toString();
      return `${blobUrl}?${sas}`;
    },
  };
}
