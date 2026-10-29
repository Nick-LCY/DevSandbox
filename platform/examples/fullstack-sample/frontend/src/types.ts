/** 后端接口返回的数据形状。 */

export interface UserInfo {
  id: string;
  name: string;
  email: string | null;
  username: string | null;
  picture: string | null;
}

export interface RecordItem {
  id: string;
  title: string;
  content: string;
  ownerId: string;
  ownerName: string;
  objectKey: string | null;
  objectName: string | null;
  objectSize: number | null;
  contentType: string | null;
  createdAt: string | null;
}
