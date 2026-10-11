"use client";
import { useEffect, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import type { Category, Cloth, WearLog } from "@outfit/schemas";
import {addDays,weekday} from '@outfit/domain';
import { api, dateLabel, todayJst } from "../lib/client";
import { categoryLabels, Empty, Heading, Loading, Notice } from "./ui";
export function History() {
  const [month, setMonth] = useState(todayJst().slice(0, 7));
  const [selectedDate,setSelectedDate]=useState('');
  const [logs, setLogs] = useState<WearLog[]>([]);
  const [clothes, setClothes] = useState<Cloth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState("");
  const [selected, setSelected] = useState<Partial<Record<Category, string>>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const firstDate=`${month}-01`;
  const calendarStart=addDays(firstDate,1-weekday(firstDate));
  const calendarDays=Array.from({length:42},(_,i)=>addDays(calendarStart,i));
  const displayedLogs=selectedDate?logs.filter(log=>log.target_date===selectedDate):logs;
  async function load() {
    const [h, c] = await Promise.all([
      api("GET /api/wear-logs", { query: { month } }),
      api("GET /api/clothes"),
    ]);
    setLogs(h.items);
    setClothes(c.items);
  }
  useEffect(() => {
    setLoading(true);
    load()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [month]);
  async function wash(id: string) {
    setBusy(true);
    setError("");
    try {
      await api("POST /api/clothes/:id/washed", { params: { id }, body: {} });
      await load();
      setMessage("洗濯済みにしました。次の提案に使えます。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function correct() {
    setBusy(true);
    setError("");
    try {
      await api("PATCH /api/wear-logs/:date", {
        params: { date: editing },
        body: {
          items: Object.entries(selected)
            .filter(([, id]) => id)
            .map(([slot, clothes_id]) => ({
              slot: slot as Category,
              clothes_id: clothes_id!,
            })),
        },
      });
      await load();
      setEditing("");
      setMessage("着用記録と着用回数を訂正しました");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading eyebrow="WORN & LOVED" title="着た服の記録">
        「これを着た」で残した、あなたの毎日。
      </Heading>
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}
      <div className="history-layout">
        <section>
          <label className="month-picker">
            表示する月
            <input
              type="month"
              value={month}
              onChange={(e) => {if(e.target.value){setMonth(e.target.value);setSelectedDate('');}}}
            />
          </label>
          <div className="history-calendar" aria-label="着用カレンダー">
            {['月','火','水','木','金','土','日'].map(day=><span className="calendar-weekday" key={day}>{day}</span>)}
            {calendarDays.map(date=><button key={date} type="button" disabled={!date.startsWith(month)} className={`${logs.some(log=>log.target_date===date)?'worn':''} ${date===selectedDate?'selected':''}`} aria-pressed={date===selectedDate} aria-label={`${dateLabel(date)} ${logs.some(log=>log.target_date===date)?'着用記録あり':'記録なし'}`} onClick={()=>setSelectedDate(date===selectedDate?'':date)}>{Number(date.slice(-2))}<span aria-hidden="true"/></button>)}
          </div>
          {selectedDate&&<button className="text-button" onClick={()=>setSelectedDate('')}>この月の記録をすべて表示</button>}
          {loading ? (
            <Loading />
          ) : displayedLogs.length === 0 ? (
            <Empty title="まだ着用記録がありません">
              <p>
                今日の画面で「これを着た」を押すと記録されます。提案しただけでは、着用回数は増えません。
              </p>
            </Empty>
          ) : (
            <div className="history-list">
              {displayedLogs.map((log) => (
                <article className="panel" key={log.id}>
                  <div className="section-top">
                    <h2>{dateLabel(log.target_date)}</h2>
                    <span className="tag">
                      <Check size={12} />
                      着用済み
                    </span>
                  </div>
                  <p>
                    {log.items
                      .map((i) => {
                        const c =
                          i.clothes ??
                          clothes.find((c) => c.id === i.clothes_id);
                        return c
                          ? `${c.color}の${categoryLabels[c.category]}`
                          : "削除済みの服";
                      })
                      .join(" ＋ ")}
                  </p>
                  <button
                    className="text-button"
                    onClick={() => {
                      setEditing(log.target_date);
                      setSelected(
                        Object.fromEntries(
                          log.items.flatMap((i) => {
                            const c =
                              i.clothes ??
                              clothes.find((c) => c.id === i.clothes_id);
                            return c ? [[c.category, c.id]] : [];
                          }),
                        ),
                      );
                    }}
                  >
                    記録を訂正
                  </button>
                  {editing === log.target_date && (
                    <div className="correction-form">
                      {Object.entries(categoryLabels).map(([slot, label]) => (
                        <label key={slot}>
                          {label}
                          <select
                            value={selected[slot as Category] ?? ""}
                            onChange={(e) =>
                              setSelected({
                                ...selected,
                                [slot]: e.target.value,
                              })
                            }
                          >
                            <option value="">選択なし</option>
                            {clothes
                              .filter((c) => c.category === slot)
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.color} {c.subtype || label}
                                </option>
                              ))}
                          </select>
                        </label>
                      ))}
                      <div className="actions">
                        <button
                          className="button primary"
                          disabled={busy || !selected.top || !selected.bottom}
                          onClick={correct}
                        >
                          訂正を保存
                        </button>
                        <button
                          className="button secondary"
                          onClick={() => setEditing("")}
                        >
                          キャンセル
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
        <aside className="panel laundry-panel">
          <span className="eyebrow">FRESH START</span>
          <h2>洗濯を終えたら</h2>
          <p>服ごとにワンタップでリセット。</p>
          {clothes.filter(
            (c) => c.wears_since_wash > 0 || c.state === "laundry",
          ).length === 0 ? (
            <p className="subtle">今はすべての服が洗濯済みです。</p>
          ) : (
            clothes
              .filter((c) => c.wears_since_wash > 0 || c.state === "laundry")
              .map((c) => (
                <div className="laundry-item" key={c.id}>
                  <span>
                    {c.color} {categoryLabels[c.category]}
                    <small>
                      {c.wears_since_wash} / {c.wear_limit}回{" "}
                      {c.state === "laundry" ? "・洗濯待ち" : ""}
                    </small>
                  </span>
                  <button
                    className="icon-button"
                    aria-label={`${c.color}の${categoryLabels[c.category]}を洗濯済みにする`}
                    disabled={busy}
                    onClick={() => wash(c.id)}
                  >
                    <RotateCcw size={18} />
                  </button>
                </div>
              ))
          )}
        </aside>
      </div>
    </>
  );
}
