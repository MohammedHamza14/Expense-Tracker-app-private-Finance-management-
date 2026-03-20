// ============================================================
// Analytics.jsx
// Drop-in Analytics page for the team expense tracker app.
//
// Dependencies (already in your project):
//   - Firebase Firestore  (firebase/firestore)
//   - useAuth context     (../contexts/AuthContext or wherever yours lives)
//   - Tailwind CSS
//   - Chart.js            (npm install chart.js)
//
// Adjust the import path for useAuth to match your project.
// ============================================================

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "../firebase";           // ← your Firebase init file
import { useAuth } from "../context/AuthContext"; // ← adjust path if needed
import { Chart, registerables } from "chart.js";

Chart.register(...registerables);

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORY_COLORS = {
    Food: "#f87171",
    Transport: "#60a5fa",
    Shopping: "#fbbf24",
    Health: "#34d399",
    Entertainment: "#a78bfa",
    Bills: "#fb923c",
    Travel: "#f472b6",
    Other: "#94a3b8",
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ─── Utility helpers ──────────────────────────────────────────────────────────

/** Format a number as INR currency (swap locale/currency as needed) */
const fmt = (n) =>
    new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    }).format(n ?? 0);

/** Returns { year, month } for a Date object */
const ym = (d) => ({ year: d.getFullYear(), month: d.getMonth() });

/** True if expense date falls in the given { year, month } */
const inMonth = (isoDate, year, month) => {
    const d = new Date(isoDate);
    return d.getFullYear() === year && d.getMonth() === month;
};

/** Returns Monday–Sunday bounds of the week containing `now` */
function getWeekBounds(now = new Date()) {
    const day = now.getDay(); // 0 = Sun
    const sun = new Date(now);
    sun.setDate(now.getDate() - day);
    sun.setHours(0, 0, 0, 0);
    const sat = new Date(sun);
    sat.setDate(sun.getDate() + 6);
    sat.setHours(23, 59, 59, 999);
    return { sun, sat };
}

/** Group an expense array by category → { [cat]: total } */
function groupByCategory(expenses) {
    return expenses.reduce((acc, e) => {
        acc[e.category] = (acc[e.category] || 0) + e.amount;
        return acc;
    }, {});
}

// ─── Reusable Chart Wrappers ──────────────────────────────────────────────────

/**
 * Doughnut / Pie chart for category breakdown.
 * Destroys and recreates the Chart.js instance whenever `data` changes.
 */
function CategoryPieChart({ data }) {
    const canvasRef = useRef(null);
    const chartRef = useRef(null);

    useEffect(() => {
        if (!canvasRef.current) return;

        // Destroy previous instance to avoid "Canvas already in use" error
        if (chartRef.current) {
            chartRef.current.destroy();
            chartRef.current = null;
        }

        const labels = Object.keys(data);
        const values = Object.values(data);
        if (labels.length === 0) return;

        chartRef.current = new Chart(canvasRef.current, {
            type: "doughnut",
            data: {
                labels,
                datasets: [
                    {
                        data: values,
                        backgroundColor: labels.map((l) => CATEGORY_COLORS[l] || "#94a3b8"),
                        borderColor: "#0f172a",
                        borderWidth: 2,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: "62%",
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                const total = values.reduce((a, b) => a + b, 0);
                                return ` ${fmt(ctx.raw)}  (${((ctx.raw / total) * 100).toFixed(1)}%)`;
                            },
                        },
                    },
                },
            },
        });

        return () => {
            if (chartRef.current) {
                chartRef.current.destroy();
                chartRef.current = null;
            }
        };
    }, [data]); // re-render chart when data changes

    return (
        <div className="relative" style={{ height: 220 }}>
            <canvas ref={canvasRef} />
        </div>
    );
}

/**
 * Bar chart for weekly day-by-day spending.
 */
function WeeklyBarChart({ dayTotals }) {
    const canvasRef = useRef(null);
    const chartRef = useRef(null);

    useEffect(() => {
        if (!canvasRef.current) return;
        if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }

        chartRef.current = new Chart(canvasRef.current, {
            type: "bar",
            data: {
                labels: DAY_LABELS,
                datasets: [
                    {
                        label: "Spending",
                        data: dayTotals,
                        backgroundColor: dayTotals.map((_, i) => {
                            const today = new Date().getDay();
                            return i === today ? "#60a5fa" : "#1e3a5f";
                        }),
                        borderRadius: 6,
                        borderSkipped: false,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (ctx) => ` ${fmt(ctx.raw)}` } },
                },
                scales: {
                    x: {
                        ticks: { color: "#94a3b8", font: { size: 12 } },
                        grid: { display: false },
                    },
                    y: {
                        ticks: {
                            color: "#94a3b8",
                            font: { size: 11 },
                            callback: (v) => "₹" + (v >= 1000 ? (v / 1000).toFixed(0) + "k" : v),
                        },
                        grid: { color: "rgba(148,163,184,0.08)" },
                    },
                },
            },
        });

        return () => {
            if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
        };
    }, [dayTotals]);

    return (
        <div className="relative" style={{ height: 200 }}>
            <canvas ref={canvasRef} />
        </div>
    );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Simple KPI card */
function StatCard({ label, value, sub, trendPct }) {
    const up = trendPct > 0;
    const neutral = trendPct == null;
    return (
        <div className="bg-slate-800 rounded-2xl p-5 flex flex-col gap-1 border border-slate-700">
            <span className="text-xs text-slate-400 tracking-wide uppercase">{label}</span>
            <span className="text-2xl font-semibold text-white">{value}</span>
            {sub && <span className="text-xs text-slate-500">{sub}</span>}
            {!neutral && (
                <span className={`text-xs font-medium mt-1 ${up ? "text-red-400" : "text-emerald-400"}`}>
                    {up ? "↑" : "↓"} {Math.abs(trendPct).toFixed(1)}% vs last month
                </span>
            )}
        </div>
    );
}

/** Category row in the breakdown list */
function CategoryRow({ name, amount, total }) {
    const pct = total > 0 ? (amount / total) * 100 : 0;
    const color = CATEGORY_COLORS[name] || "#94a3b8";
    return (
        <div className="flex items-center gap-3 py-2">
            {/* Color dot */}
            <span
                className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                style={{ background: color }}
            />
            {/* Name */}
            <span className="text-sm text-slate-300 flex-1 truncate">{name}</span>
            {/* Progress bar */}
            <div className="w-24 bg-slate-700 rounded-full h-1.5 hidden sm:block">
                <div
                    className="h-1.5 rounded-full transition-all duration-500"
                    style={{ width: `${pct}%`, background: color }}
                />
            </div>
            {/* Percentage */}
            <span className="text-xs text-slate-500 w-9 text-right">{pct.toFixed(0)}%</span>
            {/* Amount */}
            <span className="text-sm font-medium text-white w-20 text-right">{fmt(amount)}</span>
        </div>
    );
}

/** Section wrapper card */
function Section({ title, children, action }) {
    return (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-slate-300 tracking-wide uppercase">{title}</h2>
                {action}
            </div>
            {children}
        </div>
    );
}

/** Empty state placeholder */
function Empty({ message = "No expenses found for this period." }) {
    return (
        <div className="flex flex-col items-center justify-center py-10 gap-2 text-slate-500">
            <svg width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round"
                    d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 
             1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375
             c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75
             c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 
             1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21
             a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375
             a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5l-3.719-3.719
             a1.5 1.5 0 00-2.121 0l-1.5 1.5" />
            </svg>
            <p className="text-sm">{message}</p>
        </div>
    );
}

/** Loading spinner */
function Loader() {
    return (
        <div className="flex items-center justify-center py-16">
            <svg
                className="animate-spin h-8 w-8 text-blue-400"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
            >
                <circle className="opacity-25" cx="12" cy="12" r="10"
                    stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor"
                    d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
        </div>
    );
}

// ─── Main Analytics Component ─────────────────────────────────────────────────

export default function Analytics() {
    // ── Auth ──────────────────────────────────────────────────
    const { currentUser } = useAuth();

    // ── State ─────────────────────────────────────────────────
    const [expenses, setExpenses] = useState([]);  // all expenses for this user
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    // ── Fetch from Firestore ──────────────────────────────────
    useEffect(() => {
        if (!currentUser) return;

        const fetchExpenses = async () => {
            setLoading(true);
            setError(null);
            try {
                // Query: only documents belonging to the logged-in user
                const q = query(
                    collection(db, "expenses"),
                    where("userId", "==", currentUser.uid)
                );
                const snapshot = await getDocs(q);
                const data = snapshot.docs.map((doc) => ({
                    id: doc.id,
                    ...doc.data(),
                }));
                setExpenses(data);
            } catch (err) {
                console.error("Analytics fetch error:", err);
                setError("Failed to load expense data. Please try again.");
            } finally {
                setLoading(false);
            }
        };

        fetchExpenses();
    }, [currentUser]);

    // ── Date anchors ──────────────────────────────────────────
    const now = new Date();
    const thisYM = ym(now);
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevYM = ym(prevDate);

    // ── Derived data (memoised for performance) ───────────────

    /** All expenses that belong to the current calendar month */
    const thisMonthExp = useMemo(
        () => expenses.filter((e) => inMonth(e.date, thisYM.year, thisYM.month)),
        [expenses, thisYM.year, thisYM.month]
    );

    /** All expenses that belong to the previous calendar month */
    const prevMonthExp = useMemo(
        () => expenses.filter((e) => inMonth(e.date, prevYM.year, prevYM.month)),
        [expenses, prevYM.year, prevYM.month]
    );

    /** Sum helpers */
    const sum = (arr) => arr.reduce((s, e) => s + (e.amount || 0), 0);
    const thisMonthTotal = useMemo(() => sum(thisMonthExp), [thisMonthExp]);
    const prevMonthTotal = useMemo(() => sum(prevMonthExp), [prevMonthExp]);

    /** % change: positive = spending went up, negative = spending went down */
    const trendPct = useMemo(() => {
        if (prevMonthTotal === 0) return null;
        return ((thisMonthTotal - prevMonthTotal) / prevMonthTotal) * 100;
    }, [thisMonthTotal, prevMonthTotal]);

    /** Category breakdown for current month */
    const catBreakdown = useMemo(
        () => groupByCategory(thisMonthExp),
        [thisMonthExp]
    );

    /** Sorted category entries (highest first) */
    const sortedCategories = useMemo(
        () => Object.entries(catBreakdown).sort((a, b) => b[1] - a[1]),
        [catBreakdown]
    );

    /** Daily totals for Sun–Sat of the current week */
    const weeklyDayTotals = useMemo(() => {
        const { sun, sat } = getWeekBounds(now);
        const weekExp = expenses.filter((e) => {
            const d = new Date(e.date);
            return d >= sun && d <= sat;
        });
        // Build array of 7 zeros (index = day-of-week 0=Sun…6=Sat)
        const totals = Array(7).fill(0);
        weekExp.forEach((e) => {
            const dayIdx = new Date(e.date).getDay();
            totals[dayIdx] += e.amount || 0;
        });
        return totals;
    }, [expenses]);

    const weeklyTotal = useMemo(
        () => weeklyDayTotals.reduce((a, b) => a + b, 0),
        [weeklyDayTotals]
    );

    // ── Render ────────────────────────────────────────────────
    if (!currentUser) {
        return (
            <div className="min-h-screen bg-slate-950 flex items-center justify-center">
                <p className="text-slate-400">Please log in to view analytics.</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-950 text-white px-4 py-8 sm:px-6 lg:px-10">

            {/* ── Page Header ── */}
            <div className="mb-8">
                <h1 className="text-2xl font-bold text-white tracking-tight">
                    Expense Analytics
                </h1>
                <p className="text-sm text-slate-500 mt-1">
                    {now.toLocaleString("default", { month: "long", year: "numeric" })} · your spending overview
                </p>
            </div>

            {/* ── Error Banner ── */}
            {error && (
                <div className="mb-6 bg-red-900/40 border border-red-700 text-red-300
                        text-sm rounded-xl px-4 py-3">
                    {error}
                </div>
            )}

            {/* ── Loading ── */}
            {loading ? (
                <Loader />
            ) : (
                <div className="grid gap-6">

                    {/* ── Row 1: KPI Cards ── */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                        <StatCard
                            label="This Month"
                            value={fmt(thisMonthTotal)}
                            sub={`${thisMonthExp.length} transactions`}
                            trendPct={trendPct}
                        />
                        <StatCard
                            label="Last Month"
                            value={fmt(prevMonthTotal)}
                            sub={`${prevMonthExp.length} transactions`}
                        />
                        <StatCard
                            label="This Week"
                            value={fmt(weeklyTotal)}
                            sub="Sun – Sat"
                        />
                        <StatCard
                            label="Daily Average"
                            value={fmt(thisMonthTotal / (now.getDate() || 1))}
                            sub="this month"
                        />
                    </div>

                    {/* ── Row 2: Category Breakdown + Pie Chart ── */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                        {/* Category List */}
                        <Section title="Category Breakdown">
                            {sortedCategories.length === 0 ? (
                                <Empty />
                            ) : (
                                <div className="divide-y divide-slate-800">
                                    {sortedCategories.map(([name, amount]) => (
                                        <CategoryRow
                                            key={name}
                                            name={name}
                                            amount={amount}
                                            total={thisMonthTotal}
                                        />
                                    ))}
                                </div>
                            )}
                        </Section>

                        {/* Pie Chart */}
                        <Section title="Category Distribution">
                            {sortedCategories.length === 0 ? (
                                <Empty />
                            ) : (
                                <>
                                    <CategoryPieChart data={catBreakdown} />
                                    {/* Custom legend below chart */}
                                    <div className="flex flex-wrap gap-x-4 gap-y-2 mt-4 justify-center">
                                        {sortedCategories.map(([name]) => (
                                            <span key={name} className="flex items-center gap-1.5 text-xs text-slate-400">
                                                <span
                                                    className="w-2 h-2 rounded-sm"
                                                    style={{ background: CATEGORY_COLORS[name] || "#94a3b8" }}
                                                />
                                                {name}
                                            </span>
                                        ))}
                                    </div>
                                </>
                            )}
                        </Section>
                    </div>

                    {/* ── Row 3: Weekly Bar Chart ── */}
                    <Section
                        title="Weekly Spending"
                        action={
                            <span className="text-xs text-slate-500">
                                Total: <span className="text-white font-medium">{fmt(weeklyTotal)}</span>
                            </span>
                        }
                    >
                        {weeklyTotal === 0 ? (
                            <Empty message="No spending recorded this week." />
                        ) : (
                            <WeeklyBarChart dayTotals={weeklyDayTotals} />
                        )}

                        {/* Day-by-day summary below chart */}
                        <div className="grid grid-cols-7 gap-1 mt-4">
                            {DAY_LABELS.map((day, i) => {
                                const isToday = i === now.getDay();
                                return (
                                    <div
                                        key={day}
                                        className={`text-center rounded-lg py-2 px-1
                      ${isToday ? "bg-blue-900/40 ring-1 ring-blue-700" : "bg-slate-800"}`}
                                    >
                                        <p className={`text-xs mb-1 ${isToday ? "text-blue-400" : "text-slate-500"}`}>
                                            {day}
                                        </p>
                                        <p className="text-xs font-medium text-white truncate">
                                            {weeklyDayTotals[i] > 0
                                                ? "₹" + (weeklyDayTotals[i] >= 1000
                                                    ? (weeklyDayTotals[i] / 1000).toFixed(1) + "k"
                                                    : weeklyDayTotals[i].toFixed(0))
                                                : "—"}
                                        </p>
                                    </div>
                                );
                            })}
                        </div>
                    </Section>

                    {/* ── Row 4: Month-over-Month Trend ── */}
                    <Section title="Monthly Trend">
                        <div className="flex flex-col sm:flex-row gap-6 items-start sm:items-center">

                            {/* Trend indicator block */}
                            <div className="flex items-center gap-4">
                                <div
                                    className={`text-4xl font-bold ${trendPct == null
                                        ? "text-slate-500"
                                        : trendPct > 0
                                            ? "text-red-400"
                                            : "text-emerald-400"
                                        }`}
                                >
                                    {trendPct == null
                                        ? "—"
                                        : (trendPct > 0 ? "↑ " : "↓ ") + Math.abs(trendPct).toFixed(1) + "%"}
                                </div>
                                <div className="text-sm text-slate-400 leading-relaxed">
                                    {trendPct == null ? (
                                        "No data for last month."
                                    ) : trendPct > 0 ? (
                                        <>Spending is <span className="text-red-400 font-medium">higher</span> than last month</>
                                    ) : (
                                        <>Spending is <span className="text-emerald-400 font-medium">lower</span> than last month</>
                                    )}
                                </div>
                            </div>

                            {/* Comparison pills */}
                            <div className="flex gap-3 ml-auto flex-wrap">
                                <div className="bg-slate-800 rounded-xl px-4 py-2 text-center min-w-[100px]">
                                    <p className="text-xs text-slate-500 mb-1">This month</p>
                                    <p className="text-sm font-semibold text-white">{fmt(thisMonthTotal)}</p>
                                </div>
                                <div className="bg-slate-800 rounded-xl px-4 py-2 text-center min-w-[100px]">
                                    <p className="text-xs text-slate-500 mb-1">Last month</p>
                                    <p className="text-sm font-semibold text-white">{fmt(prevMonthTotal)}</p>
                                </div>
                                <div
                                    className={`rounded-xl px-4 py-2 text-center min-w-[100px] ${trendPct == null
                                        ? "bg-slate-800"
                                        : trendPct > 0
                                            ? "bg-red-900/30"
                                            : "bg-emerald-900/30"
                                        }`}
                                >
                                    <p className="text-xs text-slate-500 mb-1">Difference</p>
                                    <p
                                        className={`text-sm font-semibold ${trendPct == null
                                            ? "text-slate-400"
                                            : trendPct > 0
                                                ? "text-red-400"
                                                : "text-emerald-400"
                                            }`}
                                    >
                                        {fmt(Math.abs(thisMonthTotal - prevMonthTotal))}
                                    </p>
                                </div>
                            </div>
                        </div>
                    </Section>

                </div>
            )}
        </div>
    );
}
