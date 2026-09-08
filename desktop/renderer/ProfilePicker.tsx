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
  previousId,
  busy,
  cancel,
  choose,
}: {
  company: string;
  title: string;
  choices: ProfileChoices;
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
      aria-labelledby="profile-picker-title"
      className="profile-picker"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) cancel();
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
      <p className="hint">
        本次填写与附件上传使用所选版本；不会改变其他岗位或默认简历。继续后还需确认网站资料披露，最终提交由你在官网完成。
      </p>
      <div className="actions">
        <button disabled={busy} onClick={cancel}>
          返回
        </button>
        <button
          className="primary"
          disabled={busy || !version}
          onClick={() => choose(id)}
        >
          使用此版本并继续
        </button>
      </div>
    </dialog>
  );
}
