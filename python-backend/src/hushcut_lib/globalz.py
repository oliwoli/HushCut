from hushcut_lib.local_types import ProjectData
from typing import Optional

PROJECT_DATA: Optional[ProjectData] = None

TASKS: dict[str, int] = {
    "prepare": 30,
    "append": 30,
    "verify": 15,
    "link": 35,
}
