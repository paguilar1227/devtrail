// src/storage/blob.ts
import { BlobServiceClient } from '@azure/storage-blob';

export interface BlobStorage {
  upload(blobName: string, data: Buffer, contentType: string): Promise<string>;
  exists(blobName: string): Promise<boolean>;
  getUrl(blobName: string): string;
}

export function createBlobStorage(connectionString: string, containerName: string): BlobStorage {
  const serviceClient = BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = serviceClient.getContainerClient(containerName);

  return {
    async upload(blobName: string, data: Buffer, contentType: string): Promise<string> {
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.upload(data, data.length, {
        blobHTTPHeaders: { blobContentType: contentType },
      });
      return blockBlobClient.url;
    },

    async exists(blobName: string): Promise<boolean> {
      try {
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.getProperties();
        return true;
      } catch (err: any) {
        if (err.statusCode === 404) return false;
        throw err;
      }
    },

    getUrl(blobName: string): string {
      return containerClient.getBlockBlobClient(blobName).url;
    },
  };
}
