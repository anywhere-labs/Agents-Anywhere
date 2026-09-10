import assert from "node:assert/strict"
import test from "node:test"
import { sortDevicesByName } from "../src/components/sidebar/device-list-order.ts"

const names = devices => sortDevicesByName(devices.map((name, index) => ({ id: String(index), name }))).map(device => device.name)

test("device names use fixed Chinese pinyin and natural Latin ordering", () => {
  assert.deepEqual(names(["张三的电脑", "李四的电脑", "陈五的电脑", "阿明的电脑"]), ["阿明的电脑", "陈五的电脑", "李四的电脑", "张三的电脑"])
  assert.deepEqual(names(["zeta", "Mac 10", "apple", "Mac 2", "Beta"]), ["apple", "Beta", "Mac 2", "Mac 10", "zeta"])
})

test("same names, case, presence updates and reversed API responses cannot shuffle devices", () => {
  const devices = [
    { id: "c", name: " Office ", status: "online" },
    { id: "a", name: "office", status: "offline" },
    { id: "b", name: "OFFICE", status: "online" },
    { id: "d", name: "中文电脑", status: "offline" },
  ]
  const expected = sortDevicesByName(devices).map(device => device.id)
  assert.deepEqual(expected.filter(id => id !== "d"), ["a", "b", "c"])
  assert.deepEqual(sortDevicesByName([...devices].reverse().map(device => ({ ...device, status: "offline" }))).map(device => device.id), expected)
  assert.deepEqual(devices.map(device => device.id), ["c", "a", "b", "d"])
})
