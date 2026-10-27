import { ApiClient } from './ApiClient';
import { objGetOptString, objGetRecord } from 'common';

export interface PublicAnnouncement {
  markdown: string;
  publishedAt: string;
}

export function announcementTimestamp(value: string): number {
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return parsed;
}

export class AnnouncementsApi {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  async current(serverUrl: string): Promise<PublicAnnouncement | null> {
    const response = await this.client.getJson(serverUrl, '/announcement');
    const payload = objGetRecord(response, 'announcement');
    if (payload === null) {
      return null;
    }
    const markdown = objGetOptString(payload, 'markdown') ?? '';
    const publishedAt = objGetOptString(payload, 'publishedAt') ?? '';
    if (markdown.trim().length === 0) {
      return null;
    }
    if (announcementTimestamp(publishedAt) <= 0) {
      return null;
    }
    const announcement: PublicAnnouncement = {
      markdown: markdown,
      publishedAt: publishedAt
    };
    return announcement;
  }
}
