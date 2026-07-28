export type AvailabilitySlot = {
  start_at: string;
  end_at: string;
};

export type WorkingHoursInterval = {
  start: string;
  end: string;
};

export type WeeklyWorkingHours = Record<
  string,
  WorkingHoursInterval[]
>;

export type AvailabilityMode =
  | "normal"
  | "degraded";

export type AvailabilityResult = {
  consultant_id: string;
  slots: AvailabilitySlot[];
  generated_at: string;
  cache_ttl_seconds: 120;
  availability_mode: AvailabilityMode;
  calendar_connected: boolean;
};
