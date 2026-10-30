from connector.planning.domain.session import SessionPlanning, plan_title


def finalize(state: SessionPlanning, native_id: str, text: str) -> dict:
    assert state.finalize(native_id, text, turn_id=None, native_review=None)
    return state.proposal


def test_revision_requested_plan_keeps_plan_id_and_increments_version() -> None:
    state = SessionPlanning("s1", "codex")
    first = finalize(state, "native-1", "# 计划\n\n写入 PLAN_V1")
    state.review.update(status="revision_requested", actions=[])

    state.update_draft("native-2", "写入", append=True)
    assert state.draft["planId"] == first["planId"]
    assert state.draft["revision"] == 2

    second = finalize(state, "native-2", "# 计划\n\n写入 PLAN_V2")
    assert second["planId"] == first["planId"]
    assert second["revision"] == 2
    assert state.review["planRevision"] == 2


def test_new_plan_after_dismiss_or_approval_starts_a_new_plan() -> None:
    state = SessionPlanning("s1", "codex")
    first = finalize(state, "native-1", "# A\n\nbody")
    state.review.update(status="dismissed", actions=[])

    second = finalize(state, "native-2", "# B\n\nbody")
    assert second["planId"] != first["planId"]
    assert second["revision"] == 1


def test_late_events_of_an_earlier_native_item_stay_in_its_plan() -> None:
    state = SessionPlanning("s1", "codex")
    first = finalize(state, "native-1", "# A\n\nbody")
    state.review.update(status="revision_requested", actions=[])
    finalize(state, "native-2", "# A\n\nrevised")

    # A repeated final event for the revised item does not create version 3.
    assert not state.finalize("native-2", "# A\n\nrevised", turn_id=None, native_review=None)
    assert state.plan_id_for("native-1") == first["planId"]
    assert [p["revision"] for p in state.proposals] == [1, 2]


def test_saved_state_without_lineage_still_loads() -> None:
    saved = SessionPlanning("s1", "codex").saved()
    saved.pop("plan_ids")
    assert SessionPlanning(**saved).plan_ids == {}


def test_plan_title_uses_any_heading_or_first_line_without_markdown() -> None:
    assert plan_title("## 最小工具实施计划\n\n正文") == "最小工具实施计划"
    assert plan_title("批准后，在当前目录创建 `plan-result.txt`。\n\n审批前不写文件。") == (
        "批准后，在当前目录创建 plan-result.txt。"
    )
    assert plan_title("1. **新增** 文件") == "新增 文件"
    assert plan_title("内容精确为 `PLAN_V2`，__强调__ 与 snake_case") == "内容精确为 PLAN_V2，强调 与 snake_case"
    assert plan_title("x" * 80).endswith("…")
    assert len(plan_title("x" * 80)) == 60
