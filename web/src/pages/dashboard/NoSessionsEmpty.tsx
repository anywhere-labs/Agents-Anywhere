import { KlawMark } from "../../components/Icons";

export function NoSessionsEmpty() {
  return (
    <div className="kl-empty-wrap" data-screen-label="04 No sessions yet">
      <div className="kl-empty">
        <div className="kl-noses">
          <div className="illo" aria-hidden="true">
            <div className="card c1" />
            <div className="card c2" />
            <div className="card c3">
              <div className="bar">
                <span className="dot" />
                session
              </div>
              <div className="ln w1" />
              <div className="ln w2" />
              <div className="ln w3" />
            </div>
            <span className="mark">
              <KlawMark size={26} />
            </span>
          </div>

          <div className="tag">Ready when you are.</div>
          <div className="sub">Start building something interesting.</div>
        </div>
      </div>
    </div>
  );
}
