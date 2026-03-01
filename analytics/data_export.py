"""
Data Export Script — Aria Recommendation Engine
Pulls user preferences and session data from PostgreSQL into CSVs.

Usage:
    cd analytics/
    pip install -r requirements.txt
    cp ../.env .env
    python data_export.py
"""

import os
import json
import psycopg2
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL not set in .env")


def get_connection():
    return psycopg2.connect(DATABASE_URL)


def export_user_preferences():
    """Export user preferences including affinity scores."""
    conn = get_connection()
    query = """
        SELECT
            up.user_id,
            u.display_name,
            u.home_location,
            up.category,
            up.value,
            up.confidence,
            COALESCE(up.affinity_score, 0.5) AS affinity_score,
            up.rejected_entities,
            up.preferred_entities,
            up.updated_at
        FROM user_preferences up
        JOIN users u ON u.user_id = up.user_id
        WHERE u.authenticated = TRUE
        ORDER BY up.user_id, up.category
    """
    df = pd.read_sql(query, conn)
    conn.close()

    # Normalize rejected/preferred entities
    df["rejected_count"] = df["rejected_entities"].apply(
        lambda x: len(json.loads(x)) if x and x != "[]" else 0
    )
    df["preferred_count"] = df["preferred_entities"].apply(
        lambda x: len(json.loads(x)) if x and x != "[]" else 0
    )

    df.drop(columns=["rejected_entities", "preferred_entities"], inplace=True)
    df.to_csv("data/user_preferences.csv", index=False)
    print(f"✅ Exported {len(df)} user preference rows → data/user_preferences.csv")
    return df


def export_graph_relations():
    """Export entity-relationship graph (likes, visited, prefers, wants_to_visit)."""
    conn = get_connection()
    query = """
        SELECT
            ge.user_id,
            ge.source,
            gr.relation,
            gr.destination,
            ge.source_type,
            ge.destination_type,
            ge.created_at
        FROM graph_entities ge
        JOIN graph_relations gr ON ge.entity_id = gr.source_entity_id
        WHERE gr.relation IN ('likes', 'visited', 'prefers', 'wants_to_visit', 'dislikes', 'avoids')
        ORDER BY ge.user_id, ge.created_at DESC
    """
    try:
        df = pd.read_sql(query, conn)
        df.to_csv("data/graph_relations.csv", index=False)
        print(f"✅ Exported {len(df)} graph relation rows → data/graph_relations.csv")
        conn.close()
        return df
    except Exception as e:
        print(f"⚠️  Graph export skipped: {e}")
        conn.close()
        return pd.DataFrame()


def export_session_tool_usage():
    """Export tool usage from sessions (implicit preference signals)."""
    conn = get_connection()
    query = """
        SELECT
            user_id,
            tool_name,
            COUNT(*) AS usage_count,
            AVG(execution_time_ms) AS avg_latency_ms,
            SUM(CASE WHEN success THEN 1 ELSE 0 END) AS success_count
        FROM tool_log
        WHERE created_at > NOW() - INTERVAL '90 days'
        GROUP BY user_id, tool_name
        ORDER BY user_id, usage_count DESC
    """
    try:
        df = pd.read_sql(query, conn)
        df.to_csv("data/tool_usage.csv", index=False)
        print(f"✅ Exported {len(df)} tool usage rows → data/tool_usage.csv")
        conn.close()
        return df
    except Exception as e:
        print(f"⚠️  Tool usage export skipped: {e}")
        conn.close()
        return pd.DataFrame()


def create_sample_restaurants_csv():
    """
    Create a sample restaurant CSV if Swiggy/Zomato data isn't available.
    In production, replace with actual scraped data from Aria's Swiggy/Zomato scrapers.
    """
    import random

    cuisines = [
        "North Indian", "South Indian", "Chinese", "Italian", "Mexican",
        "Bengali", "Rajasthani", "Street Food", "Continental", "Thai",
        "Japanese", "Mughlai", "Kerala", "Andhra", "Hyderabadi",
    ]
    areas = [
        "Koramangala", "Indiranagar", "Whitefield", "HSR Layout",
        "JP Nagar", "Jayanagar", "Basavanagudi", "MG Road", "BTM Layout",
        "Marathahalli", "Bellandur", "Sarjapur Road",
    ]

    restaurants = []
    for i in range(500):
        cuisine = random.choice(cuisines)
        cost = random.choice([200, 300, 400, 500, 600, 800, 1000, 1200, 1500])
        restaurants.append({
            "name": f"Restaurant {i+1}",
            "cuisine": cuisine,
            "rating": round(random.uniform(3.2, 4.9), 1),
            "cost_for_two": cost,
            "area": random.choice(areas),
            "delivery_time": random.randint(20, 60),
            "offers_count": random.randint(0, 5),
            "bestseller_items": ", ".join(
                random.sample(
                    ["Biryani", "Butter Naan", "Paneer Tikka", "Masala Dosa", "Pasta",
                     "Pizza", "Burger", "Tacos", "Sushi", "Dim Sum"], 3
                )
            ),
            "budget_category": (
                "budget" if cost < 400
                else "mid" if cost <= 800
                else "premium"
            ),
        })

    df = pd.DataFrame(restaurants)
    df.to_csv("data/restaurants.csv", index=False)
    print(f"✅ Created sample restaurant dataset ({len(df)} records) → data/restaurants.csv")
    return df


if __name__ == "__main__":
    os.makedirs("data", exist_ok=True)

    print("📦 Exporting data from Aria's PostgreSQL database...\n")

    try:
        export_user_preferences()
    except Exception as e:
        print(f"❌ user_preferences export failed: {e}")

    try:
        export_graph_relations()
    except Exception as e:
        print(f"❌ graph_relations export failed: {e}")

    try:
        export_session_tool_usage()
    except Exception as e:
        print(f"❌ tool_usage export failed: {e}")

    # Create sample restaurant dataset (replace with real scraped data)
    create_sample_restaurants_csv()

    print("\n✅ Export complete. Now run: jupyter notebook recommendation_engine.ipynb")
