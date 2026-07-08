export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_memory: {
        Row: {
          confidence: number | null
          content: string
          created_at: string
          hit_count: number
          id: string
          kind: string
          last_used_at: string | null
          related_values: string[] | null
          scope: string
          source_thread_id: string | null
          subject: string
          subject_kind: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          confidence?: number | null
          content: string
          created_at?: string
          hit_count?: number
          id?: string
          kind: string
          last_used_at?: string | null
          related_values?: string[] | null
          scope?: string
          source_thread_id?: string | null
          subject: string
          subject_kind?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          confidence?: number | null
          content?: string
          created_at?: string
          hit_count?: number
          id?: string
          kind?: string
          last_used_at?: string | null
          related_values?: string[] | null
          scope?: string
          source_thread_id?: string | null
          subject?: string
          subject_kind?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      artifact_reviews: {
        Row: {
          artifact_id: string
          created_at: string
          id: string
          note: string | null
          state: string
          thread_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          artifact_id: string
          created_at?: string
          id?: string
          note?: string | null
          state: string
          thread_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          artifact_id?: string
          created_at?: string
          id?: string
          note?: string | null
          state?: string
          thread_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      artifacts: {
        Row: {
          confidence: number | null
          created_at: string
          id: string
          kind: string
          metadata: Json | null
          source: string | null
          thread_id: string
          user_id: string
          value: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          id?: string
          kind: string
          metadata?: Json | null
          source?: string | null
          thread_id: string
          user_id: string
          value: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          id?: string
          kind?: string
          metadata?: Json | null
          source?: string | null
          thread_id?: string
          user_id?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "artifacts_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "threads"
            referencedColumns: ["id"]
          },
        ]
      }
      evidence_log: {
        Row: {
          archive_bytes: number | null
          archive_content_type: string | null
          archive_sha256: string | null
          archive_storage_path: string | null
          artifact_id: string | null
          chain_hash: string
          classification: string
          collected_at: string
          confidence: number | null
          content_hash: string
          content_snapshot: string | null
          id: string
          kind: string | null
          metadata: Json
          prev_hash: string
          seq: number
          source: string | null
          source_url: string | null
          thread_id: string
          tool_name: string | null
          user_id: string
          value: string | null
        }
        Insert: {
          archive_bytes?: number | null
          archive_content_type?: string | null
          archive_sha256?: string | null
          archive_storage_path?: string | null
          artifact_id?: string | null
          chain_hash: string
          classification: string
          collected_at?: string
          confidence?: number | null
          content_hash: string
          content_snapshot?: string | null
          id?: string
          kind?: string | null
          metadata?: Json
          prev_hash: string
          seq: number
          source?: string | null
          source_url?: string | null
          thread_id: string
          tool_name?: string | null
          user_id: string
          value?: string | null
        }
        Update: {
          archive_bytes?: number | null
          archive_content_type?: string | null
          archive_sha256?: string | null
          archive_storage_path?: string | null
          artifact_id?: string | null
          chain_hash?: string
          classification?: string
          collected_at?: string
          confidence?: number | null
          content_hash?: string
          content_snapshot?: string | null
          id?: string
          kind?: string | null
          metadata?: Json
          prev_hash?: string
          seq?: number
          source?: string | null
          source_url?: string | null
          thread_id?: string
          tool_name?: string | null
          user_id?: string
          value?: string | null
        }
        Relationships: []
      }
      investigation_cache: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          result_json: Json
          seed_kind: string
          seed_value_normalized: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          id?: string
          result_json: Json
          seed_kind: string
          seed_value_normalized: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          result_json?: Json
          seed_kind?: string
          seed_value_normalized?: string
          user_id?: string
        }
        Relationships: []
      }
      investigator_notes: {
        Row: {
          body: string
          created_at: string
          id: string
          thread_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body?: string
          created_at?: string
          id?: string
          thread_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          thread_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          created_at: string
          id: string
          parts: Json
          role: string
          thread_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          parts: Json
          role: string
          thread_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          parts?: Json
          role?: string
          thread_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "threads"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      security_tests: {
        Row: {
          category: string
          created_at: string
          duration_ms: number | null
          id: string
          input_snippet: string | null
          name: string
          notes: string | null
          output_snippet: string | null
          passed: boolean
          run_id: string
          severity: string
          user_id: string
        }
        Insert: {
          category: string
          created_at?: string
          duration_ms?: number | null
          id?: string
          input_snippet?: string | null
          name: string
          notes?: string | null
          output_snippet?: string | null
          passed: boolean
          run_id: string
          severity?: string
          user_id: string
        }
        Update: {
          category?: string
          created_at?: string
          duration_ms?: number | null
          id?: string
          input_snippet?: string | null
          name?: string
          notes?: string | null
          output_snippet?: string | null
          passed?: boolean
          run_id?: string
          severity?: string
          user_id?: string
        }
        Relationships: []
      }
      threads: {
        Row: {
          archive_attachments: boolean
          cost_micro_usd: number
          created_at: string
          credits_used: number
          id: string
          seed_type: string | null
          seed_value: string | null
          status: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          archive_attachments?: boolean
          cost_micro_usd?: number
          created_at?: string
          credits_used?: number
          id?: string
          seed_type?: string | null
          seed_value?: string | null
          status?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          archive_attachments?: boolean
          cost_micro_usd?: number
          created_at?: string
          credits_used?: number
          id?: string
          seed_type?: string | null
          seed_value?: string | null
          status?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      tool_call_cache: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          input_hash: string
          input_json: Json
          investigation_id: string
          output_json: Json
          params_hash: string | null
          selector_normalized: string | null
          selector_type: string | null
          source_created_at: string | null
          stale: boolean
          tool_name: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          input_hash: string
          input_json: Json
          investigation_id: string
          output_json: Json
          params_hash?: string | null
          selector_normalized?: string | null
          selector_type?: string | null
          source_created_at?: string | null
          stale?: boolean
          tool_name: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          input_hash?: string
          input_json?: Json
          investigation_id?: string
          output_json?: Json
          params_hash?: string | null
          selector_normalized?: string | null
          selector_type?: string | null
          source_created_at?: string | null
          stale?: boolean
          tool_name?: string
          user_id?: string | null
        }
        Relationships: []
      }
      tool_usage_log: {
        Row: {
          cached: boolean
          charged_micro_usd: number
          cost_micro_usd: number
          created_at: string
          duration_ms: number | null
          error_msg: string | null
          id: string
          input_json: Json | null
          ok: boolean
          outcome: string | null
          status_code: number | null
          thread_id: string
          tool_name: string
          user_id: string
        }
        Insert: {
          cached?: boolean
          charged_micro_usd?: number
          cost_micro_usd?: number
          created_at?: string
          duration_ms?: number | null
          error_msg?: string | null
          id?: string
          input_json?: Json | null
          ok?: boolean
          outcome?: string | null
          status_code?: number | null
          thread_id: string
          tool_name: string
          user_id: string
        }
        Update: {
          cached?: boolean
          charged_micro_usd?: number
          cost_micro_usd?: number
          created_at?: string
          duration_ms?: number | null
          error_msg?: string | null
          id?: string
          input_json?: Json | null
          ok?: boolean
          outcome?: string | null
          status_code?: number | null
          thread_id?: string
          tool_name?: string
          user_id?: string
        }
        Relationships: []
      }
      user_credits: {
        Row: {
          balance_micro_usd: number
          blocked: boolean
          created_at: string
          daily_spent_micro_usd: number
          daily_window_start: string
          spent_micro_usd: number
          unlimited: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          balance_micro_usd?: number
          blocked?: boolean
          created_at?: string
          daily_spent_micro_usd?: number
          daily_window_start?: string
          spent_micro_usd?: number
          unlimited?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          balance_micro_usd?: number
          blocked?: boolean
          created_at?: string
          daily_spent_micro_usd?: number
          daily_window_start?: string
          spent_micro_usd?: number
          unlimited?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      thread_metrics: {
        Row: {
          artifacts: number | null
          breaches: number | null
          low_conf: number | null
          thread_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "artifacts_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "threads"
            referencedColumns: ["id"]
          },
        ]
      }
      tool_health: {
        Row: {
          last_seen_at: string | null
          ok_pct: number | null
          p50_duration_ms: number | null
          p95_duration_ms: number | null
          sample_size: number | null
          tool_name: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      append_evidence: {
        Args: {
          _artifact_id: string
          _classification: string
          _confidence: number
          _content_snapshot: string
          _kind: string
          _metadata: Json
          _source: string
          _source_url: string
          _thread_id: string
          _tool_name: string
          _value: string
        }
        Returns: {
          id: string
          out_chain_hash: string
          out_seq: number
        }[]
      }
      bump_memory_hits: { Args: { _ids: string[] }; Returns: undefined }
      debit_user_credits: {
        Args: {
          _amount_micro_usd: number
          _daily_cap_micro_usd?: number
          _user_id: string
        }
        Returns: {
          balance: number
          daily_spent: number
          ok: boolean
          reason: string
          unlimited: boolean
        }[]
      }
      get_insights_summary: { Args: { p_user_id?: string }; Returns: Json }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      increment_thread_cost: {
        Args: { _delta_cost: number; _id: string }
        Returns: undefined
      }
      save_agent_memories: {
        Args: {
          _entries: Json
          _scope?: string
          _thread_id: string
          _user_id: string
        }
        Returns: {
          id: string
          out_hit_count: number
          out_kind: string
          out_subject: string
        }[]
      }
      verify_evidence_chain: {
        Args: { _thread_id: string }
        Returns: {
          first_break: number
          ok: boolean
          total: number
        }[]
      }
    }
    Enums: {
      app_role: "admin" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "user"],
    },
  },
} as const
