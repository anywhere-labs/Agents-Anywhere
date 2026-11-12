/* eslint-disable */
/**
 * Generated from protocol 1.2 artifact creation-request.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

/**
 * @maxItems 10
 */
export type Attachments =
  | []
  | [InlineAttachmentRef]
  | [InlineAttachmentRef, InlineAttachmentRef]
  | [InlineAttachmentRef, InlineAttachmentRef, InlineAttachmentRef]
  | [InlineAttachmentRef, InlineAttachmentRef, InlineAttachmentRef, InlineAttachmentRef]
  | [InlineAttachmentRef, InlineAttachmentRef, InlineAttachmentRef, InlineAttachmentRef, InlineAttachmentRef]
  | [
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
    ]
  | [
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
    ]
  | [
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
    ]
  | [
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
    ]
  | [
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
      InlineAttachmentRef,
    ]
export type Contentbase64 = string
export type Fileid = string
export type Mediatype = string
export type Name = string
export type Sha256 = string | null
export type Size = number | null
export type Catalogrevision = number
export type Clientmessageid = string
export type Configuration = {
  [k: string]: string | boolean
} | null
export type Content = string
export type Createoperationid = string
export type Expectedrevision = number
export type Preparationid = string
export type Title = string | null

export interface BeginCreationRequest {
  attachments?: Attachments
  catalogRevision: Catalogrevision
  clientMessageId: Clientmessageid
  configuration?: Configuration
  content: Content
  createOperationId: Createoperationid
  expectedRevision: Expectedrevision
  preparationId: Preparationid
  selections: Selections
  title?: Title
}
export interface InlineAttachmentRef {
  contentBase64: Contentbase64
  fileId: Fileid
  mediaType?: Mediatype
  name: Name
  sha256?: Sha256
  size?: Size
  [k: string]: unknown
}
export interface Selections {
  [k: string]: string | null
}
