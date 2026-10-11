"use client";
export default function ErrorPage({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <div className="narrow">
      <h1>画面を表示できませんでした</h1>
      <p>通信状態を確認して、もう一度お試しください。</p>
      <button className="button primary" onClick={reset}>
        もう一度試す
      </button>
    </div>
  );
}
