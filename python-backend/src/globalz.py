from local_types import ProjectData
from typing import Optional

PROJECT_DATA: Optional[ProjectData]


TASKS: dict[str, int] = {
    "init": 2,
    "pre_process": 10,
    "append": 30,
    "verify": 8,
    "link": 35,
}
