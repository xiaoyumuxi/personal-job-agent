import { useEffect, useRef, useState } from "react";
import type { ProfileView } from "../contract.js";
export type ProfileChoices = Pick<
  ProfileView,
  "selected" | "versions" | "activeId"
>;
export function ProfilePicker({
  company,
  title,
  choices,
  draftCounts,
  previousId,
  busy,
  cancel,
  choose,
}: {
  company: string;
  title: string;
  choices: ProfileChoices;
  draftCounts: Record<string, number>;
  previousId?: string;
  busy: boolean;
  cancel: () => void;
  choose: (id: string) => Promise<unknown>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [id, setId] = useState(previousId ?? choices.activeId);
  const version = choices.versions.find((v) => v.id === id);
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      aria-labelledby="profile-picker-title"
      className="profile-picker"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) cancel();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const elements = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex='0']",
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const first = elements[0],
          last = elements.at(-1);
        if (!first) {
          e.preventDefault();
          e.currentTarget.focus();
        } else if (
          !elements.includes(document.activeElement as HTMLElement) ||
          (!e.shiftKey && document.activeElement === last)
        ) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      }}
    >
      <h2 id="profile-picker-title">选择本次使用的简历</h2>
      <p>
        {company} · {title}
      </p>
      <label>
        简历版本
        <select
          aria-label="本次投递简历"
          value={id}
          disabled={busy}
          onChange={(e) => setId(e.target.value)}
        >
          {!version && (
            <option value={id}>此前使用的版本不可读取，请重新选择</option>
          )}
          {choices.versions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      {version && (
        <p className="hint">
          修订 {version.revision} · {version.file || "未导入附件"}
        </p>
      )}
      {!!draftCounts[id] && (
        <p className="callout warning">
          此版本有 {draftCounts[id]}{" "}
          项未确认草稿。请返回“简历与资料”确认保存，或放弃本次修改后再继续，避免使用修改前的资料。
        </p>
      )}
      <p className="hint">
        本次填写与附件上传使用所选版本；不会改变其他岗位或默认简历。继续后还需确认网站资料披露，最终提交由你在官网完成。
      </p>
      <div className="actions">
        <button disabled={busy} onClick={cancel}>
          返回
        </button>
        <button
          className="primary"
          disabled={busy || !version || !!draftCounts[id]}
          onClick={() => choose(id)}
        >
          使用此版本并继续
        </button>
      </div>
    </dialog>
  );
}
