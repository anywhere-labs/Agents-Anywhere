import StarterKit from "@tiptap/starter-kit"
import { Markdown } from "@tiptap/markdown"
import { TableKit } from "@tiptap/extension-table"
import TaskList from "@tiptap/extension-task-list"
import TaskItem from "@tiptap/extension-task-item"
import Image from "@tiptap/extension-image"

export const planMarkdownExtensions = [
  StarterKit.configure({ link: { openOnClick: false } }),
  Markdown,
  TableKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  Image,
]
